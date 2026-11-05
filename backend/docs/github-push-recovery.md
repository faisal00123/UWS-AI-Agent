# GitHub push access recovery (403 on `git push`)

**Problem (verified):** `git push origin main` fails with:

```
remote: Permission to faisal00123/UWS-AI-Agent.git denied to keertikumari39-tech.
fatal: unable to access 'https://github.com/faisal00123/UWS-AI-Agent.git/': The requested URL returned error: 403
```

**Diagnosis (verified, read-only):**

| Check | Result |
|---|---|
| Local commits | intact — `main` = `aefe9a7`, ahead of `origin/main` (`76c3252`). **Nothing was deleted and nothing will be.** |
| Local git identity | `faisal00123 <faisal00123@users.noreply.github.com>` (correct — unchanged) |
| Stored credential (Windows Credential Manager, helper = `manager`) | belongs to **`keertikumari39-tech`**, which has **no write access** to `faisal00123/UWS-AI-Agent` |
| `gh` CLI | installed, **not logged in** (`gh auth status` → "You are not logged into any GitHub hosts") |
| Fetch/clone | works (read access is fine) — only **push** is denied |

Repository ownership is **not** changed by any step below, and no local commit
is discarded.

## Option A — re-authenticate this machine as `faisal00123` (recommended)

1. Delete the wrong stored credential (PowerShell):

   ```powershell
   cmdkey /delete:git:https://github.com
   ```

   (Or open **Credential Manager → Windows Credentials** and delete the
   `git:https://github.com` entry.)

2. Authenticate as `faisal00123`, either:

   - **`gh` CLI (easiest):**
     ```powershell
     gh auth login --hostname github.com --git-protocol https --web
     ```
     Follow the one-time code prompt; `gh` then stores the correct credential
     for git. Verify with `gh auth status` → should show **faisal00123**.

   - **or a Personal Access Token (PAT):**
     1. Sign in to GitHub as `faisal00123` → Settings → Developer settings →
        **Personal access tokens → Fine-grained tokens → Generate new token**.
     2. Repository access: only `faisal00123/UWS-AI-Agent`; permissions:
        **Contents: Read and write** (Metadata: read comes free).
     3. On push, when prompted: username `faisal00123`, password = the PAT.
        Windows Credential Manager will store it from then on.

3. Push the existing local commit (no force, no history changes):

   ```powershell
   git push origin main
   ```

   Expected: `76c3252..aefe9a7  main -> main`.

4. Verify: `git status -sb` → `## main...origin/main` with no `[ahead N]`.

## Option B — grant the current account access (zero local changes)

If the second account (`keertikumari39-tech`) is an intended collaborator, the
repository owner opens `https://github.com/faisal00123/UWS-AI-Agent` →
**Settings → Collaborators → Add people** → invite `keertikumari39-tech` with
**Write access** → the invite is accepted → the existing stored credential
works and `git push origin main` succeeds with no local change at all.

## Option C — owner pushes the commit for us

The owner (as `faisal00123`) runs `git push origin main` from their own
machine after pulling `aefe9a7`, or downloads/patches it — least preferred,
it forks history management across two machines.

## Guardrails

- Do **not** `git reset --hard`, do **not** `push --force`, do **not** delete
  local commits — `aefe9a7` (`.env.example` restore + `seed:demo`) must stay.
- Do **not** transfer or change repository ownership.
- Never paste a PAT into chat, logs, screenshots or commits.
