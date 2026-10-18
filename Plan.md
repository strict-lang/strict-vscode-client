Work on items reported here and when done delete them! The goal is always to keep this list empty:

- Integrate `runtime-tracing.patch` into `../Strict` and rebuild `strict.exe` so branch conditions, returns and constructor expressions provide their actual values to the client.
- Move selected-method suggestions into Strict without adding candidate searches to normal checks/tests. Reuse compiled dependencies, restrict candidates to relevant types and keep test-passing alternatives as suggestions rather than equivalence errors.
