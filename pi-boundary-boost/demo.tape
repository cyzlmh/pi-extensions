# pi-boundary-boost demo: @ completion ranks direct children first
Output demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1100
Set Height 680
Set Padding 12
Set TypingSpeed 120ms
Set Theme "Catppuccin Mocha"

Env PI_CODING_AGENT_DIR "/tmp/pi-demo-bb"

Require pi

Type "cd /tmp/pi-demo-bb-cwd"
Enter
Sleep 1s

Type "pi"
Enter
Sleep 12s

Type "@src/comp"
Sleep 9s

Escape
Sleep 1s

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 1s
