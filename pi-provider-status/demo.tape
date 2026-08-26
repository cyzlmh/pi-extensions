# pi-provider-status demo: /status
Output demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1100
Set Height 680
Set Padding 12
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Env PI_CODING_AGENT_DIR "/tmp/pi-demo-status"

Require pi

Type "cd /tmp/pi-demo-cwd"
Enter
Sleep 1s

Type "pi"
Enter
Sleep 10s

Type "/status"
Sleep 1s
Enter
Sleep 8s

Type "r"
Sleep 6s

Type "q"
Sleep 1.5s

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 1s
