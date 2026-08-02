# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial implementation: 16-step model/effort color wheel, context and rate-limit usage bars,
  git state, session cost, current task, open PR, and subagent panel rows.
- `.amplinerc.json` configuration: segment selection/order, two-line wrap point, separator,
  color toggle, branch/task truncation lengths.
- Write-through usage cache so 5-hour and weekly bars survive a cold session start, marked stale.
- `npx ampline-claude` installer with settings.json backup, foreign-statusline detection, and
  a safe uninstall path.
- Zero-dependency fixture test suite (`npm test`) and a three-OS × three-Node-version CI matrix.
