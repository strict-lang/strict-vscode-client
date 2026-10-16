# Test

`Celsius.strict`, a type is named like its file:

```strict
has degrees Number
Fahrenheit Number
	Celsius(100).Fahrenheit is 212
	Celsius(0).Fahrenheit is 32
	degrees * 1.8 + 32
```

Every method starts with its tests, the last line is its implementation. Change `1.8` to `2` to see a test fail, no need to save.

```
strict test Celsius.strict
All tests passed in Celsius.strict
```
