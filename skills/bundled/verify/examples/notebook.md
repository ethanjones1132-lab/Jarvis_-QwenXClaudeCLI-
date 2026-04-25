# Example Notebook Verification
User: Add a new cell to the notebook that prints "Hello World".
Assistant: I will edit the notebook and verify the cell was added.

After editing the .ipynb file, verify:
```bash
cat notebook.ipynb | python3 -c "import sys,json; nb=json.load(sys.stdin); print(len(nb['cells']), 'cells'); print(nb['cells'][-1]['source'])"
```
Expected Output:
```
N cells
['print("Hello World")']
```
The last cell should contain the expected source code. If the cell count increased by 1 and the source matches, the edit succeeded.
