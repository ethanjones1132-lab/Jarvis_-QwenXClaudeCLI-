# Example Directory Listing Verification
User: List files in the current directory.
Assistant: I will run `ls` and verify the output.

```bash
ls -la
```
Expected Output:
```
total X
drwxr-xr-x ... .
drwxr-xr-x ... ..
-rw-r--r-- ... package.json
-rw-r--r-- ... tsconfig.json
drwxr-xr-x ... src
...
```
Verify that:
1. The listing is non-empty (directory exists and is accessible).
2. Expected files/directories are present.
3. Permissions and ownership look correct for the context.
