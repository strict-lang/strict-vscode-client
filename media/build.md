# Build

```
strict build Hello.strict
All tests passed in Hello.strict
Built ./Hello.exe
Built ./Hello for Linux
```

`strict` installs the LLVM tools it needs (`mlir-opt`, `mlir-translate`, `clang`) when they are missing.

| More | Command |
| --- | --- |
| Validate a folder | `strict check .` |
| Count how often each line runs | `strict test Celsius.strict lines` |
| Canonical formatting | `strict format Hello.strict` |
| Refresh copied packages | `strict update .` |
