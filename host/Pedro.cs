// Pedro: native shell for the Pedro SoundCloud player.
// A frameless WinForms window that hosts WebView2 (the Edge runtime built into Windows).
// The UI lives in app\ next to the exe and is served from https://pedro.example/.
// Written for the C# 5 compiler that ships with .NET Framework 4.8 (no SDK required).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Windows.Media;
using Windows.Storage.Streams;

[assembly: System.Reflection.AssemblyTitle("Pedro")]
[assembly: System.Reflection.AssemblyProduct("Pedro")]
[assembly: System.Reflection.AssemblyDescription("Lightweight SoundCloud player")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace Pedro
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "Pedro.SoundCloudPlayer.SingleInstance", out created))
            {
                if (!created) { Native.FocusOtherInstance(); return; }
                try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)12288; }
                catch (NotSupportedException) { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(Array.IndexOf(args, "--devtools") >= 0));
            }
        }
    }

    sealed class MainForm : Form
    {
        const string AppHost = "pedro.example";
        static readonly Size FullSize = new Size(980, 640);
        static readonly Size MiniSize = new Size(380, 96);
        bool dark;                   // the page's theme, remembered so the splash matches it
        Color PageBase { get { return dark ? Color.FromArgb(20, 20, 20) : Color.FromArgb(235, 235, 235); } }

        readonly WebView2 web;
        readonly bool devtools;
        readonly string dataDir;
        readonly string statePath;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        bool mini;
        Point? fullPos, miniPos;
        int dpi = 96;
        Size fixedPx;
        readonly MediaControls media = new MediaControls();
        bool pinned;                 // "always on top" for the full window (the mini player always is)
        readonly BeatTap tap = new BeatTap();
        bool vizWanted;              // the page wants hits: cover hop on and music playing

        public MainForm(bool devtools)
        {
            this.devtools = devtools;
            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pedro");
            Directory.CreateDirectory(dataDir);
            statePath = Path.Combine(dataDir, "window.ini");
            LoadState();

            Text = "Pedro";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            FormBorderStyle = FormBorderStyle.None;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = PageBase;
            DoubleBuffered = true;
            TopMost = mini;
            Bounds = InitialBounds();

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = PageBase;
            web.Visible = false;         // the splash shows until the page is loaded (no blank window)
            Controls.Add(web);
            tap.Frame += OnTapFrame;
            SetupTray();
        }

        // Keep caption/sysmenu styles so Windows still gives us the DWM shadow, rounded
        // corners, minimize animation and taskbar click-to-minimize; WM_NCCALCSIZE hides the frame.
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.Style |= Native.WS_CAPTION | Native.WS_SYSMENU | Native.WS_MINIMIZEBOX;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int round = 2;                               // DWMWCP_ROUND
            Native.DwmSetWindowAttribute(Handle, 33, ref round, 4);
            int border = 0x00161112;                     // ink #121116 as COLORREF
            Native.DwmSetWindowAttribute(Handle, 34, ref border, 4);
            int real = Native.WindowDpi(Handle);
            if (real != dpi) { dpi = real; fixedPx = ScaleSize(mini ? MiniSize : FullSize); }
            Native.SetWindowPos(Handle, IntPtr.Zero, Left, Top, fixedPx.Width, fixedPx.Height,
                Native.SWP_NOZORDER | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try { await InitWebAsync(); }
            catch (Exception ex)
            {
                MessageBox.Show(this,
                    "Не удалось запустить WebView2.\n\n" + ex.Message +
                    "\n\nУстанови Microsoft Edge WebView2 Runtime:\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                    "Pedro", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        async Task InitWebAsync()
        {
            string appDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
            var options = new CoreWebView2EnvironmentOptions(
                "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-features=HardwareMediaKeyHandling");
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDir, "WebView2"), options);
            await web.EnsureCoreWebView2Async(env);
            if (media.Init(Handle))
                media.Pressed += key => { if (!IsDisposed) BeginInvoke(new Action(() => Media(key))); };

            var core = web.CoreWebView2;
            var s = core.Settings;
            s.AreDefaultContextMenusEnabled = devtools;
            s.AreDevToolsEnabled = devtools;
            s.AreBrowserAcceleratorKeysEnabled = devtools;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsGeneralAutofillEnabled = false;

            core.SetVirtualHostNameToFolderMapping(AppHost, appDir, CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnWebMessage;
            core.DocumentTitleChanged += delegate
            {
                Text = string.IsNullOrEmpty(core.DocumentTitle) ? "Pedro" : core.DocumentTitle;
                SetTrayTitle(Text);
            };
            core.NewWindowRequested += (o, a) => { a.Handled = true; OpenExternal(a.Uri); };
            core.NavigationStarting += (o, a) =>
            {
                if (a.Uri.StartsWith("https://" + AppHost + "/", StringComparison.OrdinalIgnoreCase)) return;
                a.Cancel = true;
                OpenExternal(a.Uri);
            };
            core.NavigationCompleted += delegate { ShowPage(); };
            var fallback = new System.Windows.Forms.Timer { Interval = 10000 };
            fallback.Tick += delegate { fallback.Dispose(); ShowPage(); };
            fallback.Start();
            core.ProcessFailed += (o, a) =>
            {
                if (a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                    a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive) core.Reload();
            };
            core.Navigate("https://" + AppHost + "/index.html" + (mini ? "?mini=1" : ""));
        }

        // ── messages from the page ───────────────────────────
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try { m = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            if (m == null) return;

            switch (Str(m, "type"))
            {
                case "win": OnWin(Str(m, "action")); break;
                case "open": OpenExternal(Str(m, "url")); break;
                case "http": DoHttp(m); break;
                case "clip-get": SendClipboard(true); break;
                case "track": media.SetTrack(Str(m, "title"), Str(m, "artist"), CoverFile(Str(m, "art"))); break;
                case "theme":
                    object d;
                    dark = m.TryGetValue("dark", out d) && true.Equals(d);
                    BackColor = PageBase;
                    web.DefaultBackgroundColor = PageBase;
                    SaveState();
                    break;
                case "viz":
                    object on;
                    vizWanted = m.TryGetValue("on", out on) && true.Equals(on);
                    UpdateTap();
                    break;
                case "state":
                    object playing;
                    media.SetPlaying(m.TryGetValue("playing", out playing) && true.Equals(playing));
                    break;
            }
        }

        void OnWin(string action)
        {
            switch (action)
            {
                case "drag":
                    Native.ReleaseCapture();
                    Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
                    break;
                case "minimize": if (trayMode) HideToTray(); else WindowState = FormWindowState.Minimized; break;
                case "close": if (trayMode) HideToTray(); else Close(); break;
                case "tray-on": trayMode = true; break;
                case "tray-off": trayMode = false; break;
                case "mini": SetMini(true); break;
                case "full": SetMini(false); break;
                case "pin-on": pinned = true; TopMost = true; break;
                case "pin-off": pinned = false; TopMost = mini; break;
            }
        }

        void SetMini(bool on)
        {
            if (on != mini && WindowState == FormWindowState.Normal)
            {
                if (mini) miniPos = Location; else fullPos = Location;
                Rectangle wa = Screen.FromHandle(Handle).WorkingArea;
                mini = on;
                fixedPx = ScaleSize(mini ? MiniSize : FullSize);
                Point? saved = mini ? miniPos : fullPos;
                Point loc = saved.HasValue && OnScreen(new Rectangle(saved.Value, fixedPx)) ? saved.Value : DefaultPos(wa);
                TopMost = mini || pinned;
                Native.SetWindowPos(Handle, IntPtr.Zero, loc.X, loc.Y, fixedPx.Width, fixedPx.Height, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                SaveState();
            }
            Post(new Dictionary<string, object> { { "type", "mode" }, { "mini", mini } });
        }

        // Network calls for the page (oEmbed, official API), limited to SoundCloud hosts over HTTPS.
        async void DoHttp(Dictionary<string, object> m)
        {
            var reply = new Dictionary<string, object>();
            reply["type"] = "http";
            reply["id"] = m.ContainsKey("id") ? m["id"] : null;
            try
            {
                var uri = new Uri(Str(m, "url"));
                if (uri.Scheme != Uri.UriSchemeHttps || !IsSoundCloudHost(uri.Host))
                    throw new InvalidOperationException("Адрес не разрешён: " + uri.Host);

                var req = (HttpWebRequest)WebRequest.Create(uri);
                req.Method = Str(m, "method") ?? "GET";
                req.UserAgent = "Pedro/1.0 (Windows)";
                req.Timeout = 15000;
                req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;

                object hv;
                var headers = m.TryGetValue("headers", out hv) ? hv as Dictionary<string, object> : null;
                if (headers != null)
                {
                    foreach (var kv in headers)
                    {
                        string v = Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
                        switch (kv.Key.ToLowerInvariant())
                        {
                            case "content-type": req.ContentType = v; break;
                            case "accept": req.Accept = v; break;
                            default: req.Headers[kv.Key] = v; break;
                        }
                    }
                }

                string body = Str(m, "body");
                if (body != null)
                {
                    byte[] data = Encoding.UTF8.GetBytes(body);
                    using (var rs = await req.GetRequestStreamAsync()) await rs.WriteAsync(data, 0, data.Length);
                }

                HttpWebResponse resp;
                try { resp = (HttpWebResponse)await req.GetResponseAsync(); }
                catch (WebException we)
                {
                    resp = we.Response as HttpWebResponse;
                    if (resp == null) throw;
                }
                using (resp)
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    reply["status"] = (int)resp.StatusCode;
                    reply["url"] = resp.ResponseUri.ToString();
                    reply["body"] = await sr.ReadToEndAsync();
                }
            }
            catch (Exception ex)
            {
                reply["error"] = ex.Message;
            }
            Post(reply);
        }

        // An uploaded file's cover comes as a data url; Windows media controls read it from a file
        // in the data folder (only the latest one is kept).
        string CoverFile(string art)
        {
            if (art == null || !art.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase)) return art;
            int comma = art.IndexOf(',');
            if (comma < 0 || art.Length > 4 * 1024 * 1024) return null;
            try
            {
                byte[] bytes = Convert.FromBase64String(art.Substring(comma + 1));
                string dir = Path.Combine(dataDir, "covers");
                Directory.CreateDirectory(dir);
                foreach (string old in Directory.GetFiles(dir))
                    try { File.Delete(old); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                string file = Path.Combine(dir, "cover-" + DateTime.UtcNow.Ticks + ".jpg");
                File.WriteAllBytes(file, bytes);
                return file;
            }
            catch (Exception) { return null; }
        }

        void Post(object msg)
        {
            if (IsDisposed || web.CoreWebView2 == null) return;
            web.CoreWebView2.PostWebMessageAsJson(json.Serialize(msg));
        }

        static void OpenExternal(string url)
        {
            Uri u;
            if (string.IsNullOrEmpty(url) || !Uri.TryCreate(url, UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttps || !IsSoundCloudHost(u.Host)) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { /* no default browser */ }
        }

        static bool IsSoundCloudHost(string host)
        {
            host = host.ToLowerInvariant();
            return host == "soundcloud.com" || host.EndsWith(".soundcloud.com", StringComparison.Ordinal);
        }

        static string Str(Dictionary<string, object> m, string key)
        {
            object v;
            return m.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null;
        }

        // ── clipboard: offer SoundCloud links copied in the browser ──
        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (web != null && web.CoreWebView2 != null) web.Focus();
            SendClipboard(false);
        }

        void SendClipboard(bool force)
        {
            if (web == null || web.CoreWebView2 == null) return;
            string text = "";
            try { if (Clipboard.ContainsText()) text = Clipboard.GetText(); }
            catch (ExternalException) { return; }
            if (!force && text.IndexOf("soundcloud.com", StringComparison.OrdinalIgnoreCase) < 0) return;
            if (text.Length > 4000) text = text.Substring(0, 4000);
            Post(new Dictionary<string, object> { { "type", "clipboard" }, { "text", text }, { "force", force } });
        }


        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (web == null || web.CoreWebView2 == null) return;
            bool minimized = WindowState == FormWindowState.Minimized;
            // The page itself stays "visible" to the browser: a hidden page defers loading the next
            // track until it is shown again. It is only told to stop its animations.
            if (!minimized && inTray) { Native.TaskbarTab(Handle, true); inTray = false; }
            Post(new Dictionary<string, object> { { "type", "shown" }, { "on", !minimized } });
            UpdateTap();
        }

        // ── splash: what the window shows while WebView2 starts (up to a few seconds on a cold start) ──
        void ShowPage()
        {
            if (web.Visible) return;
            web.Visible = true;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (!web.Visible) DrawSplash(e.Graphics);
        }

        // grid paper and the Pedro mark, like the page's background, instead of an empty window
        void DrawSplash(Graphics g)
        {
            float k = dpi / 96f;
            Color paper = PageBase, ink = dark ? Color.FromArgb(235, 235, 235) : Color.FromArgb(13, 13, 13);
            g.Clear(paper);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var grid = new Pen(Color.FromArgb(26, ink), 2 * k))
            {
                for (float x = 42 * k; x < ClientSize.Width; x += 44 * k) g.DrawLine(grid, x, 0, x, ClientSize.Height);
                for (float y = 42 * k; y < ClientSize.Height; y += 44 * k) g.DrawLine(grid, 0, y, ClientSize.Width, y);
            }
            float tile = 64 * k, gap = 18 * k;
            using (var font = new Font("Segoe UI Black", 30 * k, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var inkBrush = new SolidBrush(ink))
            using (var paperBrush = new SolidBrush(paper))
            using (var pen = new Pen(ink, 3 * k))
            {
                SizeF text = g.MeasureString("PEDRO", font);
                float x0 = (ClientSize.Width - (tile + gap + text.Width)) / 2, y0 = (ClientSize.Height - tile) / 2;
                using (var shadow = RoundRect(x0 + 6 * k, y0 + 6 * k, tile, tile, 16 * k))
                {
                    g.FillPath(paperBrush, shadow);
                    g.DrawPath(pen, shadow);
                }
                using (var body = RoundRect(x0, y0, tile, tile, 16 * k)) g.FillPath(inkBrush, body);
                float cx = x0 + tile / 2 + 3 * k, cy = y0 + tile / 2, t = 15 * k;
                g.FillPolygon(paperBrush, new[] { new PointF(cx - t * 0.8f, cy - t), new PointF(cx + t, cy), new PointF(cx - t * 0.8f, cy + t) });
                g.DrawString("PEDRO", font, inkBrush, x0 + tile + gap, y0 + (tile - text.Height) / 2);
            }
        }

        static GraphicsPath RoundRect(float x, float y, float w, float h, float r)
        {
            var p = new GraphicsPath();
            float d = r * 2;
            p.AddArc(x, y, d, d, 180, 90);
            p.AddArc(x + w - d, y, d, d, 270, 90);
            p.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            p.AddArc(x, y + h - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // ── tray: Pedro keeps playing with only an icon next to the clock ──
        NotifyIcon tray;
        ToolStripMenuItem trayTitle;
        bool trayMode = true, inTray, reallyClose, trayHinted;

        void SetupTray()
        {
            var menu = new ContextMenuStrip();
            trayTitle = new ToolStripMenuItem("Pedro") { Enabled = false };
            menu.Items.Add(trayTitle);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Играть / пауза", null, delegate { Media("playpause"); }));
            menu.Items.Add(new ToolStripMenuItem("Следующий", null, delegate { Media("next"); }));
            menu.Items.Add(new ToolStripMenuItem("Предыдущий", null, delegate { Media("prev"); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Открыть Pedro", null, delegate { ShowFromTray(); }));
            menu.Items.Add(new ToolStripMenuItem("Выход", null, delegate { reallyClose = true; Close(); }));
            tray = new NotifyIcon { Icon = Icon, Text = "Pedro", ContextMenuStrip = menu, Visible = true };
            tray.MouseClick += (o, a) =>
            {
                if (a.Button != MouseButtons.Left) return;
                if (inTray || WindowState == FormWindowState.Minimized) ShowFromTray(); else HideToTray();
            };
        }

        void Media(string key) { Post(new Dictionary<string, object> { { "type", "media" }, { "key", key } }); }

        void SetTrayTitle(string title)
        {
            if (tray == null) return;
            trayTitle.Text = title;
            tray.Text = title.Length > 63 ? title.Substring(0, 60) + "..." : title;   // NotifyIcon limit
        }

        void HideToTray()
        {
            WindowState = FormWindowState.Minimized;
            Native.TaskbarTab(Handle, false);       // no taskbar button, just the tray icon
            inTray = true;
            if (trayHinted) return;
            trayHinted = true;
            SaveState();
            tray.ShowBalloonTip(3000, "Pedro в трее", "Музыка играет дальше. Клик по значку открывает плеер, правый клик: управление и выход.", ToolTipIcon.None);
        }

        void ShowFromTray()
        {
            if (inTray) { Native.TaskbarTab(Handle, true); inTray = false; }
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        // ── beat tap: the background pulses on Pedro's own audio ──
        void UpdateTap()
        {
            if (!vizWanted || WindowState == FormWindowState.Minimized) { tap.Stop(); return; }
            if (web.CoreWebView2 != null) tap.BrowserPid = (int)web.CoreWebView2.BrowserProcessId;
            tap.Start();
        }

        void OnTapFrame(double level, double beat)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke(new Action(() => Post(new Dictionary<string, object> {
                    { "type", "beat" }, { "l", Math.Round(level, 2) }, { "b", Math.Round(beat, 2) } })));
            }
            catch (InvalidOperationException) { /* closing */ }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Alt+F4 and the like hide to the tray too; "Выход" in the tray menu really quits
            if (trayMode && !reallyClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            tap.Stop();
            SaveState();
            base.OnFormClosing(e);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case Native.WM_NCCALCSIZE:
                    if (m.WParam != IntPtr.Zero) { m.Result = IntPtr.Zero; return; }
                    break;
                case Native.WM_NCACTIVATE:
                    m.LParam = new IntPtr(-1); // skip repainting the (hidden) frame
                    break;
                case Native.WM_GETMINMAXINFO:
                    base.WndProc(ref m);
                    if (fixedPx.Width > 0)
                    {
                        var mmi = (Native.MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(Native.MINMAXINFO));
                        mmi.ptMinTrackSize = new Native.POINT(fixedPx.Width, fixedPx.Height);
                        mmi.ptMaxTrackSize = new Native.POINT(fixedPx.Width, fixedPx.Height);
                        Marshal.StructureToPtr(mmi, m.LParam, false);
                    }
                    return;
                case Native.WM_DPICHANGED:
                    dpi = (int)((long)m.WParam & 0xFFFF);
                    fixedPx = ScaleSize(mini ? MiniSize : FullSize);
                    var r = (Native.RECT)Marshal.PtrToStructure(m.LParam, typeof(Native.RECT));
                    Native.SetWindowPos(Handle, IntPtr.Zero, r.Left, r.Top, fixedPx.Width, fixedPx.Height, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                    m.Result = IntPtr.Zero;
                    return;
            }
            base.WndProc(ref m);
        }

        // ── window placement ─────────────────────────────────
        Rectangle InitialBounds()
        {
            Point? saved = mini ? miniPos : fullPos;
            Rectangle primary = Screen.PrimaryScreen.WorkingArea;
            Point anchor = saved ?? new Point(primary.Left + primary.Width / 2, primary.Top + primary.Height / 2);
            dpi = Native.DpiAt(anchor);
            fixedPx = ScaleSize(mini ? MiniSize : FullSize);
            if (saved.HasValue && OnScreen(new Rectangle(saved.Value, fixedPx))) return new Rectangle(saved.Value, fixedPx);
            return new Rectangle(DefaultPos(Screen.FromPoint(anchor).WorkingArea), fixedPx);
        }

        Point DefaultPos(Rectangle wa)
        {
            if (mini)
            {
                int gap = 24 * dpi / 96;
                return new Point(wa.Right - fixedPx.Width - gap, wa.Bottom - fixedPx.Height - gap);
            }
            return new Point(wa.Left + Math.Max(0, (wa.Width - fixedPx.Width) / 2), wa.Top + Math.Max(0, (wa.Height - fixedPx.Height) / 2));
        }

        static bool OnScreen(Rectangle r)
        {
            var grip = new Point(r.Left + Math.Min(120, r.Width / 2), r.Top + 20);
            foreach (var s in Screen.AllScreens) if (s.WorkingArea.Contains(grip)) return true;
            return false;
        }

        Size ScaleSize(Size s) { return new Size(s.Width * dpi / 96, s.Height * dpi / 96); }

        void LoadState()
        {
            try
            {
                if (!File.Exists(statePath)) return;
                foreach (var line in File.ReadAllLines(statePath))
                {
                    int eq = line.IndexOf('=');
                    if (eq < 0) continue;
                    string k = line.Substring(0, eq), v = line.Substring(eq + 1);
                    if (k == "mini") mini = v == "1";
                    else if (k == "full") fullPos = ParsePoint(v);
                    else if (k == "miniPos") miniPos = ParsePoint(v);
                    else if (k == "trayHint") trayHinted = v == "1";
                    else if (k == "dark") dark = v == "1";
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        void SaveState()
        {
            if (IsHandleCreated && WindowState == FormWindowState.Normal)
            {
                if (mini) miniPos = Location; else fullPos = Location;
            }
            try
            {
                File.WriteAllLines(statePath, new[] { "mini=" + (mini ? "1" : "0"), "full=" + FormatPoint(fullPos), "miniPos=" + FormatPoint(miniPos), "trayHint=" + (trayHinted ? "1" : "0"), "dark=" + (dark ? "1" : "0") });
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        static Point? ParsePoint(string v)
        {
            var p = v.Split(',');
            int x, y;
            if (p.Length == 2 && int.TryParse(p[0], out x) && int.TryParse(p[1], out y)) return new Point(x, y);
            return null;
        }

        static string FormatPoint(Point? p) { return p.HasValue ? p.Value.X + "," + p.Value.Y : ""; }
    }

    // Listens to Pedro's own audio only (process loopback, Windows 10 2004+): it taps the
    // audio service of Pedro's WebView2, so other apps and the microphone are never heard.
    // (Tapping Pedro.exe's process tree does not work: Windows hears silence there, because the
    // WebView2 browser is started through a broker and is not counted as part of the tree.)
    // Nothing is stored; only a level and beat strength (~20 times a second) go to the page.
    sealed class BeatTap
    {
        public event Action<double, double> Frame;
        volatile bool running;
        bool unsupported;
        public int TargetPid = Process.GetCurrentProcess().Id;
        public int BrowserPid;                               // WebView2 browser process of this window
        public int Packets, SilentPackets, MaxAbs;          // diagnostics
        public string Error;

        public void Start()
        {
            if (running || unsupported) return;
            running = true;
            new Thread(Run) { IsBackground = true, Name = "Pedro beat tap" }.Start();  // MTA thread
        }

        public void Stop() { running = false; }

        void Run()
        {
            IntPtr act = IntPtr.Zero, pv = IntPtr.Zero, fmt = IntPtr.Zero, evt = IntPtr.Zero;
            IAudioClient client = null;
            try
            {
                act = Marshal.AllocHGlobal(12);                 // AUDIOCLIENT_ACTIVATION_PARAMS
                Marshal.WriteInt32(act, 0, 1);                  // ..._TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(act, 4, BrowserPid > 0 ? FindAudioService(BrowserPid, TargetPid) : TargetPid);
                Marshal.WriteInt32(act, 8, 0);                  // INCLUDE_TARGET_PROCESS_TREE
                pv = Marshal.AllocHGlobal(24);                  // PROPVARIANT holding a VT_BLOB
                for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(pv, i, 0);
                Marshal.WriteInt16(pv, 0, 65);
                Marshal.WriteInt32(pv, 8, 12);
                Marshal.WriteIntPtr(pv, 16, act);

                var done = new ActivationHandler();
                Guid iid = typeof(IAudioClient).GUID;
                IActivateAudioInterfaceAsyncOperation op;
                Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, done, out op);
                if (!done.Done.WaitOne(3000)) { unsupported = true; return; }
                int hr;
                object o;
                op.GetActivateResult(out hr, out o);
                if (hr != 0 || o == null) { unsupported = true; return; }
                client = (IAudioClient)o;

                const int Rate = 44100;
                fmt = Marshal.AllocHGlobal(18);                 // WAVEFORMATEX: 16-bit stereo PCM
                Marshal.WriteInt16(fmt, 0, 1); Marshal.WriteInt16(fmt, 2, 2);
                Marshal.WriteInt32(fmt, 4, Rate); Marshal.WriteInt32(fmt, 8, Rate * 4);
                Marshal.WriteInt16(fmt, 12, 4); Marshal.WriteInt16(fmt, 14, 16); Marshal.WriteInt16(fmt, 16, 0);
                // LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM, 20 ms buffer
                if (client.Initialize(0, 0x20000 | 0x40000 | unchecked((int)0x80000000), 200000, 0, fmt, IntPtr.Zero) != 0) { unsupported = true; return; }
                evt = Native.CreateEvent(IntPtr.Zero, false, false, null);
                client.SetEventHandle(evt);
                Guid cid = typeof(IAudioCaptureClient).GUID;
                object co;
                if (client.GetService(ref cid, out co) != 0) { unsupported = true; return; }
                var cap = (IAudioCaptureClient)co;
                client.Start();

                var detector = new BeatDetector(Rate);
                short[] buf = new short[4096];
                while (running)
                {
                    Native.WaitForSingleObject(evt, 100);
                    uint n;
                    while (running && cap.GetNextPacketSize(out n) == 0 && n > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devPos, qpcPos;
                        if (cap.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos) != 0) break;
                        int count = (int)frames * 2;
                        if (buf.Length < count) buf = new short[count];
                        if ((flags & 2) != 0) Array.Clear(buf, 0, count); else Marshal.Copy(data, buf, 0, count);
                        cap.ReleaseBuffer(frames);
                        Packets++;
                        if ((flags & 2) != 0) SilentPackets++;
                        for (int i = 0; i < count; i++) { int v = Math.Abs((int)buf[i]); if (v > MaxAbs) MaxAbs = v; }
                        detector.Feed(buf, count, Frame);
                    }
                }
                client.Stop();
                Marshal.ReleaseComObject(cap);
            }
            catch (Exception ex) { unsupported = true; Error = ex.GetType().Name + ": " + ex.Message; }   // older Windows: the page falls back to the waveform
            finally
            {
                running = false;
                if (client != null) Marshal.ReleaseComObject(client);
                if (evt != IntPtr.Zero) Native.CloseHandle(evt);
                if (fmt != IntPtr.Zero) Marshal.FreeHGlobal(fmt);
                if (pv != IntPtr.Zero) Marshal.FreeHGlobal(pv);
                if (act != IntPtr.Zero) Marshal.FreeHGlobal(act);
            }
        }

        // the WebView2 utility process that plays the sound: a child of the browser process
        static int FindAudioService(int browserPid, int fallback)
        {
            try
            {
                using (var q = new System.Management.ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE ParentProcessId = " + browserPid))
                {
                    foreach (System.Management.ManagementObject p in q.Get())
                    {
                        var cmd = p["CommandLine"] as string;
                        if (cmd != null && cmd.IndexOf("audio.mojom.AudioService", StringComparison.OrdinalIgnoreCase) >= 0)
                            return Convert.ToInt32(p["ProcessId"]);
                    }
                }
            }
            catch (System.Management.ManagementException) { }
            return browserPid > 0 ? browserPid : fallback;   // the browser itself still hears most of the sound
        }
    }

    // Hit detection on the highs: hi-hats, snares, claps. High band = signal minus a one-pole
    // low-pass at ~3 kHz; energy per ~12 ms hop; a hit when the energy jumps well above both
    // its last ~40 ms and an adaptive threshold over the last ~1 s.
    sealed class BeatDetector
    {
        const int Hop = 512;
        readonly double a;
        double lp, sumHigh, sumAll, prevHigh, highRecent, fluxMean, fluxVar, peak = 1e-6, pending;
        int filled, sinceHit = 99, hops;

        public BeatDetector(int rate) { a = 1 - Math.Exp(-2 * Math.PI * 3000.0 / rate); }

        public void Feed(short[] s, int count, Action<double, double> emit)
        {
            for (int i = 0; i + 1 < count; i += 2)
            {
                double x = (s[i] + s[i + 1]) / 65536.0;
                lp += a * (x - lp);
                double hp = x - lp;
                sumHigh += hp * hp;
                sumAll += x * x;
                if (++filled < Hop) continue;
                Step(emit);
                filled = 0; sumHigh = 0; sumAll = 0;
            }
        }

        void Step(Action<double, double> emit)
        {
            double high = sumHigh / Hop, all = sumAll / Hop;
            double flux = Math.Max(0, high - prevHigh);
            prevHigh = high;
            double d = flux - fluxMean;
            fluxMean += d * 0.012;
            fluxVar += (d * d - fluxVar) * 0.012;
            double thr = fluxMean + 1.8 * Math.Sqrt(fluxVar);
            bool jump = high > 2.0 * highRecent;               // a hit is a sudden burst, not a steady hiss
            highRecent += (high - highRecent) * 0.3;
            sinceHit++;
            peak = Math.Max(peak * 0.9997, all);               // slow gain control: loudness, not volume
            double level = Math.Min(1, Math.Sqrt(all / peak));
            if (jump && flux > thr && flux > 1e-8 && sinceHit >= 8)     // at most one hit per ~90 ms
            {
                pending = Math.Max(pending, Math.Min(1, 0.35 + 0.6 * (flux - thr) / (thr + 1e-9)));
                sinceHit = 0;
            }
            if (++hops % 4 != 0) return;                        // ~21 messages a second
            if (emit != null) emit(level, pending);
            pending = 0;
        }
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
    }

    // Windows media controls (SMTC): headphone buttons (AirPods: 1x play/pause, 2x next,
    // 3x previous), keyboard media keys, and the track card in the volume flyout and lock screen.
    // Windows routes these to whichever player is active, so Pedro no longer grabs them globally.
    sealed class MediaControls
    {
        SystemMediaTransportControls smtc;
        public event Action<string> Pressed;

        public bool Init(IntPtr hwnd)
        {
            try
            {
                var interop = (ISystemMediaTransportControlsInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(SystemMediaTransportControls));
                Guid iid = new Guid("99FA3FF4-1742-42A6-902E-087D41F965EC");   // ISystemMediaTransportControls
                smtc = (SystemMediaTransportControls)interop.GetForWindow(hwnd, ref iid);
                smtc.IsEnabled = true;
                smtc.IsPlayEnabled = true;
                smtc.IsPauseEnabled = true;
                smtc.IsNextEnabled = true;
                smtc.IsPreviousEnabled = true;
                smtc.IsStopEnabled = true;
                smtc.PlaybackStatus = MediaPlaybackStatus.Closed;
                smtc.ButtonPressed += OnButton;
                return true;
            }
            catch (Exception) { smtc = null; return false; }   // no SMTC on this Windows
        }

        void OnButton(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
        {
            string key = null;
            switch (args.Button)
            {
                case SystemMediaTransportControlsButton.Play: key = "play"; break;
                case SystemMediaTransportControlsButton.Pause: key = "pause"; break;
                case SystemMediaTransportControlsButton.Next: key = "next"; break;
                case SystemMediaTransportControlsButton.Previous: key = "prev"; break;
                case SystemMediaTransportControlsButton.Stop: key = "stop"; break;
            }
            var handler = Pressed;
            if (key != null && handler != null) handler(key);
        }

        public void SetTrack(string title, string artist, string art)
        {
            if (smtc == null) return;
            try
            {
                var d = smtc.DisplayUpdater;
                d.Type = MediaPlaybackType.Music;
                d.MusicProperties.Title = title ?? "";
                d.MusicProperties.Artist = artist ?? "";
                Uri uri;
                if (!string.IsNullOrEmpty(art) && !art.StartsWith("http", StringComparison.OrdinalIgnoreCase) && File.Exists(art))
                {
                    // the file opens in a few ms; polled because AsTask needs the union Windows.winmd
                    var op = Windows.Storage.StorageFile.GetFileFromPathAsync(art);
                    for (int i = 0; i < 100 && op.Status == Windows.Foundation.AsyncStatus.Started; i++) Thread.Sleep(10);
                    d.Thumbnail = op.Status == Windows.Foundation.AsyncStatus.Completed ? RandomAccessStreamReference.CreateFromFile(op.GetResults()) : null;
                }
                else
                    d.Thumbnail = !string.IsNullOrEmpty(art) && Uri.TryCreate(art, UriKind.Absolute, out uri)
                        ? RandomAccessStreamReference.CreateFromUri(uri) : null;
                d.Update();
            }
            catch (Exception) { }
        }

        public void SetPlaying(bool playing)
        {
            if (smtc == null) return;
            try { smtc.PlaybackStatus = playing ? MediaPlaybackStatus.Playing : MediaPlaybackStatus.Paused; }
            catch (Exception) { }
        }
    }

    [ComImport, Guid("ddb0472d-c911-4a1f-86d9-dc3d71a95f5a"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    interface ISystemMediaTransportControlsInterop
    {
        [return: MarshalAs(UnmanagedType.IInspectable)]
        object GetForWindow(IntPtr appWindow, [In] ref Guid riid);
    }

    [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ITaskbarList
    {
        void HrInit();
        void AddTab(IntPtr hWnd);
        void DeleteTab(IntPtr hWnd);
        void ActivateTab(IntPtr hWnd);
        void SetActiveAlt(IntPtr hWnd);
    }

    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
    class TaskbarListClass { }

    static class Native
    {
        public const int WS_CAPTION = 0x00C00000, WS_SYSMENU = 0x00080000, WS_MINIMIZEBOX = 0x00020000;
        public const int WM_NCCALCSIZE = 0x0083, WM_NCACTIVATE = 0x0086, WM_GETMINMAXINFO = 0x0024;
        public const int WM_DPICHANGED = 0x02E0, WM_NCLBUTTONDOWN = 0x00A1, HTCAPTION = 2;
        public const uint SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO { public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize; }

        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

        // adds or removes the window's taskbar button (ITaskbarList)
        public static void TaskbarTab(IntPtr hWnd, bool show)
        {
            try
            {
                var list = (ITaskbarList)new TaskbarListClass();
                list.HrInit();
                if (show) list.AddTab(hWnd); else list.DeleteTab(hWnd);
                Marshal.ReleaseComObject(list);
            }
            catch (COMException) { }
        }
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        public static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid, IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateEvent(IntPtr attrs, bool manualReset, bool initialState, string name);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

        public static int WindowDpi(IntPtr hWnd)
        {
            try { uint d = GetDpiForWindow(hWnd); return d > 0 ? (int)d : 96; }
            catch (EntryPointNotFoundException) { return 96; }
        }

        public static int DpiAt(Point p)
        {
            try
            {
                uint x, y;
                IntPtr mon = MonitorFromPoint(new POINT(p.X, p.Y), 2 /* nearest */);
                if (GetDpiForMonitor(mon, 0 /* effective */, out x, out y) == 0 && x > 0) return (int)x;
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            return 96;
        }

        public static void FocusOtherInstance()
        {
            var me = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(me.ProcessName))
            {
                if (p.Id == me.Id || p.MainWindowHandle == IntPtr.Zero) continue;
                if (IsIconic(p.MainWindowHandle)) ShowWindow(p.MainWindowHandle, 9 /* SW_RESTORE */);
                SetForegroundWindow(p.MainWindowHandle);
            }
        }
    }
}
