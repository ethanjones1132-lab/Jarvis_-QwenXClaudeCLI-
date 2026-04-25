# Example Terminal Verification
User: Set an environment variable and confirm it persists.
Assistant: I will set the variable and verify.

```bash
export MY_VAR="hello"
echo $MY_VAR
```
Expected Output:
```
hello
```
If the echo returns the expected value, the variable was set correctly.
Note: Environment variables set in a subshell do not persist to the parent.
