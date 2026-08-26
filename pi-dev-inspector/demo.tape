# pi-dev-inspector demo: /system-prompt
Output demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1100
Set Height 680
Set Padding 12
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Env PI_CODING_AGENT_DIR "/tmp/pi-demo-dev"

Require pi

Type "cd /tmp/pi-demo-cwd"
Enter
Sleep 1s

Type "pi"
Enter
Sleep 10s

Type "/system-prompt"
Sleep 1s
Enter
Sleep 4s

# scroll through the prompt
Type "jjjj"
Sleep 1.5s
Type "jjjj"
Sleep 1.5s

Type "q"
Sleep 1.5s

Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 1s
