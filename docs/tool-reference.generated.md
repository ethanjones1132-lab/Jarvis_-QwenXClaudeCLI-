# Claude Code Tool Reference

Generated: 2026-04-19T20:40:21.548Z

## Invocation contract

Claude Code expects Anthropic-style structured tool-use content blocks, not freeform XML text.

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "ToolName",
  "input": {
    "example_key": "example value"
  }
}
```

Rules:
- Tool calls must use the exact tool name exposed by the runtime.
- Tool input must be strict JSON matching the input_schema for that tool.
- Do not wrap tool calls in markdown fences, XML envelopes, or explanatory prose.
- When a tool call fails, retry with the exact parameter names and types from the schema.

## Runtime tools

### Agent

- Enabled: yes
- Strict: no
- Deferred: no
- Aliases: Task
- Search hint: delegate work to a subagent
- Description: Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. (Tools: *)
- statusline-setup: Use this agent to configure the user's Claude Code status line setting. (Tools: Read, Edit)
- claude-code-guide: Use this agent when the user asks questions ("Can Claude...", "Does Claude...", "How do I...") about: (1) Claude Code (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom agents; (3) Claude API (formerly Anthropic API) - API usage, tool use, Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via SendMessage. (Tools: Glob, Grep, Read, WebFetch, WebSearch)

When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

When NOT to use the Agent tool:
- If you want to read a specific file path, use the Read tool or the Glob tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Agent tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the `to` field. The agent resumes with its full context preserved. Each Agent invocation starts fresh — provide a complete task description.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set `isolation: "worktree"` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.


Example usage:

Important: the assistant narration in these examples is illustrative only. The actual action is still a tool call, not a quoted sentence about the tool.

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the Agent tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Agent tool to launch the greeting-responder agent"
</example>

- Required parameters: `description`, `prompt`

Example input:

```json
{
  "description": "Short task summary",
  "prompt": "Describe the intended change and constraints"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Agent",
  "input": {
    "description": "Short task summary",
    "prompt": "Describe the intended change and constraints"
  }
}
```

### AskUserQuestion

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: prompt the user with a multiple-choice question
- Description: Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.

- Required parameters: `questions`

Example input:

```json
{
  "questions": [
    {
      "question": "example",
      "header": "example",
      "options": [
        {
          "label": "example",
          "description": "Short task summary"
        }
      ],
      "multiSelect": false
    }
  ]
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "example",
        "header": "example",
        "options": [
          {
            "label": "example",
            "description": "Short task summary"
          }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

### Bash

- Enabled: yes
- Strict: yes
- Deferred: no
- Search hint: execute shell commands
- Description: Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the Bash tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
 - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.
 - When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary `sleep` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.
  - If you must poll an external process, use a check command (e.g. `gh run view`) rather than sleeping first.
  - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.


# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the Bash tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message ending with:
   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the TodoWrite or Agent tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
</example>

Important:
- DO NOT use the TodoWrite or Agent tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments
- Required parameters: `command`

Example input:

```json
{
  "command": "git status"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Bash",
  "input": {
    "command": "git status"
  }
}
```

### Edit

- Enabled: yes
- Strict: yes
- Deferred: no
- Search hint: modify file contents in place
- Description: Performs exact string replacements in files.

Usage:
- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- Required parameters: `file_path`, `old_string`, `new_string`

Example input:

```json
{
  "file_path": "/absolute/path/to/file",
  "old_string": "example",
  "new_string": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Edit",
  "input": {
    "file_path": "/absolute/path/to/file",
    "old_string": "example",
    "new_string": "example"
  }
}
```

### EnterPlanMode

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: switch to plan mode to design an approach before coding
- Description: Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase


Example input:

```json
{}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "EnterPlanMode",
  "input": {}
}
```

### EnterWorktree

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: create an isolated git worktree and switch into it
- Description: Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless they specifically mention worktrees
- Never use this tool unless the user explicitly mentions "worktree"

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside `.claude/worktrees/` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Parameters

- `name` (optional): A name for the worktree. If not provided, a random name is generated.


Example input:

```json
{
  "name": "example-name"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "EnterWorktree",
  "input": {
    "name": "example-name"
  }
}
```

### ExitPlanMode

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: present plan for approval and start coding (plan mode only)
- Description: Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.


Example input:

```json
{
  "allowedPrompts": [
    {
      "tool": "Bash",
      "prompt": "Describe the intended change and constraints"
    }
  ]
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "ExitPlanMode",
  "input": {
    "allowedPrompts": [
      {
        "tool": "Bash",
        "prompt": "Describe the intended change and constraints"
      }
    ]
  }
}
```

### ExitWorktree

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: exit a worktree session and return to the original directory
- Description: Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with `git worktree add`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- `action` (required): `"keep"` or `"remove"`
  - `"keep"` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - `"remove"` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- `discard_changes` (optional, default false): only meaningful with `action: "remove"`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to `true`. If the tool returns an error listing changes, confirm with the user before re-invoking with `discard_changes: true`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory
- If a tmux session was attached to the worktree: killed on `remove`, left running on `keep` (its name is returned so the user can reattach)
- Once exited, EnterWorktree can be called again to create a fresh worktree

- Required parameters: `action`

Example input:

```json
{
  "action": "keep"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "ExitWorktree",
  "input": {
    "action": "keep"
  }
}
```

### Glob

- Enabled: yes
- Strict: no
- Deferred: no
- Search hint: find files by name pattern or wildcard
- Description: - Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead
- Required parameters: `pattern`

Example input:

```json
{
  "pattern": "example query"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Glob",
  "input": {
    "pattern": "example query"
  }
}
```

### Grep

- Enabled: yes
- Strict: yes
- Deferred: no
- Search hint: search file contents with regex (ripgrep)
- Description: A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\s+\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\{\}` to find `interface{}` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \{[\s\S]*?field`, use `multiline: true`

- Required parameters: `pattern`

Example input:

```json
{
  "pattern": "example query"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Grep",
  "input": {
    "pattern": "example query"
  }
}
```

### ListMcpResourcesTool

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: list resources from connected MCP servers
- Description: 
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field 
indicating which server the resource belongs to.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided,
  resources from all servers will be returned.


Example input:

```json
{
  "server": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "ListMcpResourcesTool",
  "input": {
    "server": "example"
  }
}
```

### NotebookEdit

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: edit Jupyter notebook cells (.ipynb)
- Description: Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.
- Required parameters: `notebook_path`, `new_source`

Example input:

```json
{
  "notebook_path": "/absolute/path/to/file",
  "new_source": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "NotebookEdit",
  "input": {
    "notebook_path": "/absolute/path/to/file",
    "new_source": "example"
  }
}
```

### Read

- Enabled: yes
- Strict: yes
- Deferred: no
- Search hint: read files, images, PDFs, notebooks
- Description: Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- Required parameters: `file_path`

Example input:

```json
{
  "file_path": "/absolute/path/to/file"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Read",
  "input": {
    "file_path": "/absolute/path/to/file"
  }
}
```

### ReadMcpResourceTool

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: read a specific MCP resource by URI
- Description: 
Reads a specific resource from an MCP server, identified by server name and resource URI.

Parameters:
- server (required): The name of the MCP server from which to read the resource
- uri (required): The URI of the resource to read

- Required parameters: `server`, `uri`

Example input:

```json
{
  "server": "example",
  "uri": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "ReadMcpResourceTool",
  "input": {
    "server": "example",
    "uri": "example"
  }
}
```

### SendMessage

- Enabled: no
- Strict: no
- Deferred: yes
- Search hint: send messages to agent teammates (swarm protocol)
- Description: # SendMessage

Send a message to another agent.

Use this only for agent-to-agent communication. Do not use it to narrate, relay, or proxy an unrelated tool invocation; if a tool should run, call that tool directly.

```json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
```

| `to` | |
|---|---|
| `"researcher"` | Teammate by name |
| `"*"` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.

## Protocol responses (legacy)

If you receive a JSON message with `type: "shutdown_request"` or `type: "plan_approval_request"`, respond with the matching `_response` type — echo the `request_id`, set `approve` true/false:

```json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
```

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate `shutdown_request` unless asked. Don't send structured JSON status messages — use TaskUpdate.
- Required parameters: `to`, `message`

Example input:

```json
{
  "to": "example",
  "message": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "SendMessage",
  "input": {
    "to": "example",
    "message": "example"
  }
}
```

### SendUserMessage

- Enabled: no
- Strict: no
- Deferred: no
- Aliases: Brief
- Search hint: send a message to the user — your primary visible output channel
- Description: Send a message the user will read. Text outside this tool is visible in the detail view, but most won't open it — the answer lives here.

`message` supports markdown. `attachments` takes file paths (absolute or cwd-relative) for images, diffs, logs.

`status` labels intent: 'normal' when replying to what they just asked; 'proactive' when you're initiating — a scheduled task finished, a blocker surfaced during background work, you need input on something they haven't asked about. Set it honestly; downstream routing uses it.

This tool is for the user-facing reply itself. Do not use it to narrate or proxy an internal tool invocation; if you need a tool, call the tool directly and then use this tool for the final user-visible answer.
- Required parameters: `message`, `status`

Example input:

```json
{
  "message": "example",
  "status": "normal"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "SendUserMessage",
  "input": {
    "message": "example",
    "status": "normal"
  }
}
```

### Skill

- Enabled: yes
- Strict: no
- Deferred: no
- Search hint: invoke a slash-command skill
- Description: Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - `skill: "pdf"` - invoke the pdf skill
  - `skill: "commit", args: "-m 'Fix bug'"` - invoke with arguments
  - `skill: "review-pr", args: "123"` - invoke with arguments
  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again

- Required parameters: `skill`

Example input:

```json
{
  "skill": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Skill",
  "input": {
    "skill": "example"
  }
}
```

### TaskOutput

- Enabled: yes
- Strict: no
- Deferred: yes
- Aliases: AgentOutputTool, BashOutputTool
- Search hint: read output/logs from a background task
- Description: DEPRECATED: Prefer using the Read tool on the task's output file path instead. Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes — Read that file directly.

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions
- Required parameters: `task_id`, `block`, `timeout`

Example input:

```json
{
  "task_id": "example",
  "block": true,
  "timeout": 30000
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "TaskOutput",
  "input": {
    "task_id": "example",
    "block": true,
    "timeout": 30000
  }
}
```

### TaskStop

- Enabled: yes
- Strict: no
- Deferred: yes
- Aliases: KillShell
- Search hint: kill a running background task
- Description: 
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task


Example input:

```json
{}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "TaskStop",
  "input": {}
}
```

### TodoWrite

- Enabled: yes
- Strict: yes
- Deferred: yes
- Search hint: manage the session task checklist
- Description: Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Examples of When to Use the Todo List

<example>
User: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!
Assistant: *Creates todo list with the following items:*
1. Creating dark mode toggle component in Settings page
2. Adding dark mode state management (context/store)
3. Implementing CSS-in-JS styles for dark theme
4. Updating existing components to support theme switching
5. Running tests and build process, addressing any failures or errors that occur
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes
2. The user explicitly requested tests and build be run afterward
3. The assistant inferred that tests and build need to pass by adding "Ensure tests and build succeed" as the final task
</reasoning>
</example>

<example>
User: Help me rename the function getCwd to getCurrentWorkingDirectory across my project
Assistant: *Uses grep or search tools to locate all instances of getCwd in the codebase*
I've found 15 instances of 'getCwd' across 8 different files.
*Creates todo list with specific items for each file that needs updating*

<reasoning>
The assistant used the todo list because:
1. First, the assistant searched to understand the scope of the task
2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps
3. The todo list helps ensure every instance is tracked and updated systematically
4. This approach prevents missing any occurrences and maintains code consistency
</reasoning>
</example>


<example>
User: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.
Assistant: *Creates a todo list breaking down each feature into specific tasks based on the project architecture*
Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.

<reasoning>
The assistant used the todo list because:
1. The user provided multiple complex features to implement in a comma separated list
2. The todo list helps organize these large features into manageable tasks
3. This approach allows for tracking progress across the entire implementation
</reasoning>
</example>

<example>
User: Can you help optimize my React application? It's rendering slowly and has performance issues.
Assistant: *Reviews component structure, render patterns, state management, and data fetching*
After analyzing your codebase, I've identified several performance issues.
*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*
Let's start by implementing memoization for the expensive calculations in your ProductList component.

<reasoning>
The assistant used the todo list because:
1. First, the assistant examined the codebase to identify specific performance issues
2. Based on this analysis, it identified multiple optimization opportunities
3. Performance optimization is a non-trivial task requiring multiple steps
4. The todo list helps methodically track improvements across different components
5. This systematic approach ensures all performance bottlenecks are addressed
</reasoning>
</example>

## Examples of When NOT to Use the Todo List

<example>
User: How do I print 'Hello World' in Python?
Assistant: In Python, you can print "Hello World" with this simple code:

python
print("Hello World")

This will output the text "Hello World" to the console when executed.

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
</reasoning>
</example>

<example>
User: What does the git status command do?
Assistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.

<reasoning>
The assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.
</reasoning>
</example>

<example>
User: Can you add a comment to the calculateTotal function to explain what it does?
Assistant: Sure, let me add a comment to the calculateTotal function to explain what it does.
* Uses the Edit tool to add a comment to the calculateTotal function *

<reasoning>
The assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.
</reasoning>
</example>

<example>
User: Run npm install for me and tell me what happens.
Assistant: I'll run the npm install command for you.

*Executes: npm install*

The command completed successfully. Here's the output:
[Output of npm install command]

All dependencies have been installed according to your package.json file.

<reasoning>
The assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.
</reasoning>
</example>

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.

- Required parameters: `todos`

Example input:

```json
{
  "todos": [
    {
      "content": "example",
      "status": "pending",
      "activeForm": "example"
    }
  ]
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "TodoWrite",
  "input": {
    "todos": [
      {
        "content": "example",
        "status": "pending",
        "activeForm": "example"
      }
    ]
  }
}
```

### WebFetch

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: fetch and extract content from a URL
- Description: IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).

- Required parameters: `url`, `prompt`

Example input:

```json
{
  "url": "https://example.com",
  "prompt": "Describe the intended change and constraints"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "WebFetch",
  "input": {
    "url": "https://example.com",
    "prompt": "Describe the intended change and constraints"
  }
}
```

### WebSearch

- Enabled: yes
- Strict: no
- Deferred: yes
- Search hint: search the web for current information
- Description: 
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is April 2026. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year

- Required parameters: `query`

Example input:

```json
{
  "query": "example query"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "WebSearch",
  "input": {
    "query": "example query"
  }
}
```

### Write

- Enabled: yes
- Strict: yes
- Deferred: no
- Search hint: create or overwrite files
- Description: Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
- Required parameters: `file_path`, `content`

Example input:

```json
{
  "file_path": "/absolute/path/to/file",
  "content": "example"
}
```

Tool-use block template:

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Write",
  "input": {
    "file_path": "/absolute/path/to/file",
    "content": "example"
  }
}
```

## Tool module inventory

### AgentTool

- Present in runtime registry: yes
- Declared names: Agent
- Declared aliases: none discovered
- Matching runtime names: Agent

### AskUserQuestionTool

- Present in runtime registry: yes
- Declared names: AskUserQuestion
- Declared aliases: none discovered
- Matching runtime names: AskUserQuestion

### BashTool

- Present in runtime registry: yes
- Declared names: Bash
- Declared aliases: none discovered
- Matching runtime names: Bash

### BriefTool

- Present in runtime registry: yes
- Declared names: SendUserMessage
- Declared aliases: none discovered
- Matching runtime names: SendUserMessage

### ConfigTool

- Present in runtime registry: no
- Declared names: Config
- Declared aliases: none discovered
- Matching runtime names: none

### CtxInspectTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### EnterPlanModeTool

- Present in runtime registry: yes
- Declared names: EnterPlanMode
- Declared aliases: none discovered
- Matching runtime names: EnterPlanMode

### EnterWorktreeTool

- Present in runtime registry: yes
- Declared names: EnterWorktree
- Declared aliases: none discovered
- Matching runtime names: EnterWorktree

### ExitPlanModeTool

- Present in runtime registry: yes
- Declared names: ExitPlanMode
- Declared aliases: none discovered
- Matching runtime names: ExitPlanMode

### ExitWorktreeTool

- Present in runtime registry: yes
- Declared names: ExitWorktree
- Declared aliases: none discovered
- Matching runtime names: ExitWorktree

### FileEditTool

- Present in runtime registry: yes
- Declared names: Edit
- Declared aliases: none discovered
- Matching runtime names: Edit

### FileReadTool

- Present in runtime registry: yes
- Declared names: Read
- Declared aliases: none discovered
- Matching runtime names: Read

### FileWriteTool

- Present in runtime registry: yes
- Declared names: Write
- Declared aliases: none discovered
- Matching runtime names: Write

### GlobTool

- Present in runtime registry: yes
- Declared names: Glob
- Declared aliases: none discovered
- Matching runtime names: Glob

### GrepTool

- Present in runtime registry: yes
- Declared names: Grep
- Declared aliases: none discovered
- Matching runtime names: Grep

### ListMcpResourcesTool

- Present in runtime registry: yes
- Declared names: ListMcpResourcesTool
- Declared aliases: none discovered
- Matching runtime names: ListMcpResourcesTool

### ListPeersTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### LSPTool

- Present in runtime registry: no
- Declared names: LSP
- Declared aliases: none discovered
- Matching runtime names: none

### McpAuthTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### MCPTool

- Present in runtime registry: no
- Declared names: mcp
- Declared aliases: none discovered
- Matching runtime names: none

### MonitorTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### NotebookEditTool

- Present in runtime registry: yes
- Declared names: NotebookEdit
- Declared aliases: none discovered
- Matching runtime names: NotebookEdit

### OverflowTestTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### PowerShellTool

- Present in runtime registry: no
- Declared names: PowerShell
- Declared aliases: none discovered
- Matching runtime names: none

### PushNotificationTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### ReadMcpResourceTool

- Present in runtime registry: yes
- Declared names: ReadMcpResourceTool
- Declared aliases: none discovered
- Matching runtime names: ReadMcpResourceTool

### RemoteTriggerTool

- Present in runtime registry: no
- Declared names: RemoteTrigger
- Declared aliases: none discovered
- Matching runtime names: none

### REPLTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### ScheduleCronTool

- Present in runtime registry: no
- Declared names: CronCreate, CronDelete, CronList
- Declared aliases: none discovered
- Matching runtime names: none

### SendMessageTool

- Present in runtime registry: yes
- Declared names: SendMessage
- Declared aliases: none discovered
- Matching runtime names: SendMessage

### SendUserFileTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### SkillTool

- Present in runtime registry: yes
- Declared names: Skill
- Declared aliases: none discovered
- Matching runtime names: Skill

### SleepTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### SnipTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### SubscribePRTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### SuggestBackgroundPRTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### SyntheticOutputTool

- Present in runtime registry: no
- Declared names: StructuredOutput
- Declared aliases: none discovered
- Matching runtime names: none

### TaskCreateTool

- Present in runtime registry: no
- Declared names: TaskCreate
- Declared aliases: none discovered
- Matching runtime names: none

### TaskGetTool

- Present in runtime registry: no
- Declared names: TaskGet
- Declared aliases: none discovered
- Matching runtime names: none

### TaskListTool

- Present in runtime registry: no
- Declared names: TaskList
- Declared aliases: none discovered
- Matching runtime names: none

### TaskOutputTool

- Present in runtime registry: yes
- Declared names: TaskOutput
- Declared aliases: AgentOutputTool, BashOutputTool
- Matching runtime names: TaskOutput

### TaskStopTool

- Present in runtime registry: yes
- Declared names: TaskStop
- Declared aliases: KillShell
- Matching runtime names: TaskStop

### TaskUpdateTool

- Present in runtime registry: no
- Declared names: TaskUpdate
- Declared aliases: none discovered
- Matching runtime names: none

### TeamCreateTool

- Present in runtime registry: no
- Declared names: TeamCreate
- Declared aliases: none discovered
- Matching runtime names: none

### TeamDeleteTool

- Present in runtime registry: no
- Declared names: TeamDelete
- Declared aliases: none discovered
- Matching runtime names: none

### TerminalCaptureTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### TodoWriteTool

- Present in runtime registry: yes
- Declared names: TodoWrite
- Declared aliases: none discovered
- Matching runtime names: TodoWrite

### ToolSearchTool

- Present in runtime registry: no
- Declared names: ToolSearch
- Declared aliases: none discovered
- Matching runtime names: none

### TungstenTool

- Present in runtime registry: no
- Declared names: Tungsten
- Declared aliases: none discovered
- Matching runtime names: none

### VerifyPlanExecutionTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### WebBrowserTool

- Present in runtime registry: no
- Declared names: none discovered
- Declared aliases: none discovered
- Matching runtime names: none
- Discovery error: No runtime tool name or alias declaration could be extracted from top-level module sources.

### WebFetchTool

- Present in runtime registry: yes
- Declared names: WebFetch
- Declared aliases: none discovered
- Matching runtime names: WebFetch

### WebSearchTool

- Present in runtime registry: yes
- Declared names: web_search, WebSearch
- Declared aliases: none discovered
- Matching runtime names: WebSearch

### WorkflowTool

- Present in runtime registry: no
- Declared names: WorkflowTool
- Declared aliases: none discovered
- Matching runtime names: none

