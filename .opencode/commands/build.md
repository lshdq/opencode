---
description: execute the Windows x64 build workflow
---

Load the `windows-build` Skill before doing anything else, then execute the repository's Windows x64 build contract.

Pass the user's arguments through to `packages/cli/script/build-win.ps1` unchanged. Supported options include `-BuildOnly`, `-NoDeploy`, `-SkipInstall`, `-Bun`, and `-DeployRoot`, along with other existing build-script parameters.

User build arguments:

$ARGUMENTS
