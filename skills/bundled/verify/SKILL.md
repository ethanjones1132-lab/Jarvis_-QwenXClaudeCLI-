# Verification Skill
**Description**: Protocols for verifying tool outputs and system state.
**Version**: 2.1.88-leaked

## Instructions
1. After executing any command that modifies the file system or environment, you must verify the result.
2. Use `ls`, `cat`, or specific CLI version flags (e.g., `--version`) to confirm success.
3. Compare the actual output against the "Expected Output" defined in the bundled examples.
4. If a verification fails, do not proceed with the plan. Auto-correct the error or report to the user.

## Examples
- See `./examples/cli.md` for terminal verification.
- See `./examples/filesystem.md` for file edit verification.
