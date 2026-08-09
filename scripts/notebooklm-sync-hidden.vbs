Option Explicit

If WScript.Arguments.Count = 1 Then
    If WScript.Arguments(0) = "--self-test" Then
        WScript.Quit 0
    End If
End If

If WScript.Arguments.Count = 0 Then
    WScript.Quit 2
End If

Dim shell, powershellPath, command, index
Set shell = CreateObject("WScript.Shell")
powershellPath = shell.ExpandEnvironmentStrings( _
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" _
)
command = QuoteArgument(powershellPath)

For index = 0 To WScript.Arguments.Count - 1
    command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

WScript.Quit shell.Run(command, 0, True)

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
