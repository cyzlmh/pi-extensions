# pi-bg-tasks demo: background bash task + completion notification
Output demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1100
Set Height 680
Set Padding 12
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

Env PI_CODING_AGENT_DIR "/tmp/pi-demo-bg"

Require pi

Type "cd /tmp/pi-demo-cwd"
Enter
Sleep 1s

Type "pi"
Enter
Sleep 12s

Type "Run 'sleep 8 && echo done' in the background with the bash tool (run_in_background: true). Do not wait for it."
Sleep 1s
Enter
Sleep 25s

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 1s
