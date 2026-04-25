# Example Browser Verification
User: Check that the dev server is responding on port 3000.
Assistant: I will verify the server is accessible.

Verification:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
```
Expected Output:
```
200
```
A `200` status code confirms the server is running and responding.
If you get `000` or `curl: (7) Failed to connect`, the server is not running.
