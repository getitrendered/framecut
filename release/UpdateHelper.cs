using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace FramecutRelease
{
    public sealed class Installer
    {
        public string path { get; set; }
        public string digest { get; set; }
        public string version { get; set; }
        public bool patch { get; set; }
    }

    public sealed class UpdateJob
    {
        public int pid { get; set; }
        public Installer installer { get; set; }
        public string executable { get; set; }
        public string profile { get; set; }
        public string statusFile { get; set; }
        public string readyFile { get; set; }
    }

    internal static class UpdateHelper
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length != 1) return 1;
            var json = new JavaScriptSerializer();
            UpdateJob job;
            try
            {
                job = json.Deserialize<UpdateJob>(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
                if (job == null || job.installer == null || !Path.IsPathRooted(job.statusFile) ||
                    !Path.IsPathRooted(job.readyFile)) return 1;
                File.WriteAllText(job.readyFile, "ready");
            }
            catch { return 1; }

            var applied = false;
            string error = null;
            try
            {
                WaitForEditor(job.pid);
                VerifyInstaller(job.installer);
                if (job.installer.patch) ApplyAppPackage(job, json);
                else Install(job);
                applied = true;
            }
            catch (Exception failure) { error = failure.Message; }

            try
            {
                var status = json.Serialize(new { version = job.installer.version, ok = applied, error = error });
                var temporary = job.statusFile + ".partial";
                File.WriteAllText(temporary, status, new UTF8Encoding(false));
                if (File.Exists(job.statusFile)) File.Replace(temporary, job.statusFile, null);
                else File.Move(temporary, job.statusFile);
            }
            catch { /* Relaunch even if the profile could not record the result. */ }

            try
            {
                if (File.Exists(job.executable))
                    Process.Start(new ProcessStartInfo(job.executable, "--user-data-dir=" + Quote(job.profile)) {
                        UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(job.executable)
                    });
            }
            catch { return 3; }
            return applied ? 0 : 2;
        }

        private static void WaitForEditor(int id)
        {
            Process editor;
            try { editor = Process.GetProcessById(id); }
            catch (ArgumentException) { return; }
            using (editor)
            {
                if (!editor.WaitForExit(45000)) throw new IOException("Framecut did not close before the update.");
            }
        }

        private static void VerifyInstaller(Installer installer)
        {
            using (var file = File.OpenRead(installer.path))
            using (var sha256 = SHA256.Create())
            {
                var digest = BitConverter.ToString(sha256.ComputeHash(file)).Replace("-", "");
                if (!string.Equals(digest, installer.digest, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("The saved installer failed verification.");
            }
        }

        private static void Install(UpdateJob job)
        {
            var directory = Path.GetDirectoryName(job.executable);
            var log = Path.Combine(Path.GetDirectoryName(job.statusFile), "update-install.log");
            var arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCLOSEAPPLICATIONS /DIR=" +
                Quote(directory) + " /LOG=" + Quote(log);
            if (Directory.GetFiles(directory, "unins*.exe").Length == 0)
                arguments += " /framecut-portable=1";
            using (var setup = Process.Start(new ProcessStartInfo(job.installer.path, arguments) {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            }))
            {
                setup.WaitForExit();
                if (setup.ExitCode != 0) throw new IOException("Windows setup exited with code " + setup.ExitCode + ".");
            }
        }

        private static void ApplyAppPackage(UpdateJob job, JavaScriptSerializer json)
        {
            var app = Path.Combine(Path.GetDirectoryName(job.executable), "resources", "app");
            var staging = Path.Combine(app, ".update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            var updated = new List<string>();
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using (var zip = ZipFile.OpenRead(job.installer.path))
                {
                    long bytes = 0;
                    foreach (var entry in zip.Entries)
                    {
                        var name = entry.FullName;
                        if (name != Path.GetFileName(name) || name.IndexOf(':') >= 0 ||
                            !System.Text.RegularExpressions.Regex.IsMatch(name, @"^[A-Za-z0-9-]+\.(?:js|mjs|cjs|json|html|css|ico|py|exe)$") ||
                            !names.Add(name) || names.Count > 60)
                            throw new IOException("The update package contains an unexpected file.");
                        bytes += entry.Length;
                        if (bytes > 20000000) throw new IOException("The update package is too large.");
                        entry.ExtractToFile(Path.Combine(staging, name));
                    }
                }
                if (!names.Contains("package.json") || !names.Contains("desktop.mjs") || !names.Contains("UpdateHelper.exe"))
                    throw new IOException("The update package is missing required files.");
                var manifest = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(staging, "package.json")));
                if (!manifest.ContainsKey("version") || (string)manifest["version"] != job.installer.version)
                    throw new IOException("The downloaded app version does not match the release.");
                foreach (var name in names)
                {
                    var path = Path.Combine(app, name);
                    var next = Path.Combine(staging, name);
                    if (File.Exists(path)) File.Replace(next, path, next + ".backup");
                    else File.Move(next, path);
                    updated.Add(name);
                }
            }
            catch
            {
                for (var index = updated.Count - 1; index >= 0; index--)
                {
                    var name = updated[index];
                    var target = Path.Combine(app, name);
                    var backup = Path.Combine(staging, name) + ".backup";
                    if (File.Exists(backup)) File.Replace(backup, target, null);
                    else File.Delete(target);
                }
                throw;
            }
            finally { try { Directory.Delete(staging, true); } catch { } }
        }

        private static string Quote(string value)
        {
            if (value.IndexOf('"') >= 0) throw new ArgumentException("An update path contains unsupported characters.");
            var trailing = value.Length - value.TrimEnd('\\').Length;
            return "\"" + value + new string('\\', trailing) + "\"";
        }
    }
}
