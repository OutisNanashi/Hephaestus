# Hephaestus

Phase 0 provides a deliberately small, safe repository foundation. It validates configured project folders and creates a project log directory; it does not execute agents, commands, containers, API calls, reviews, or Git workflows.

## Commands

```sh
npm test
node src/cli.js --help
node src/cli.js validate
```

`validate` loads `hephaestus.config.json`, validates `projects.json`, validates the selected project’s required files and `STATE.json`, and then creates its log directory. Project paths must resolve inside `allowedRoot`.
