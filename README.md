# Framecut

Framecut is a local Windows video editor. Install the latest build from [GitHub Releases](https://github.com/getitrendered/framecut/releases). FFmpeg and FFprobe need to be available on PATH.

## Updates

Open **Updates** to check for a new version manually. Framecut also checks shortly after launch and every 30 minutes. Read the notes, click **Download update**, then choose **Save and Restart**. The editor saves the project in its existing profile and keeps a recovery checkpoint before closing. Updates are public and require no GitHub login.

## Publish a new release

1. Bump the version in `package.json`.
2. Add `release/notes/<version>.md` for the in-app release notes, or use the generated GitHub release notes.
3. Commit and push, then push a matching tag such as `v0.5.1`.

The Windows release workflow validates the tag and publishes the Windows installer and a smaller app update for compatible runtimes. Keep the installer name `Framecut-Setup-x64.exe` stable. Update `runtimeId` when changing the pinned Electron or Whisper revisions, so the editor uses the full installer across runtime changes.

To build locally on Windows with Inno Setup 6 installed, run `pwsh -File release/build.ps1`. The script verifies the pinned Electron and Whisper downloads and places the installer in `dist`. Footage, project profiles, and ProPainter files are kept outside the repository and the release.
