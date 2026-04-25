# Example Filesystem Verification
User: Add a new line "export const VERSION = '2.0'" to config.ts.
Assistant: I will edit the file and verify the change.

After editing, verify with:
```bash
cat config.ts | grep "VERSION"
```
Expected Output:
```
export const VERSION = '2.0'
```
If the grep returns the expected line, the edit was applied correctly.
If no output, the edit failed or targeted the wrong file.
