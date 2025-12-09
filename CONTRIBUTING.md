# Contributing to Jira MCP Server

Thank you for your interest in contributing! This document provides guidelines and steps for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We welcome contributors of all experience levels.

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template if available
3. Include:
   - Node.js version (`node --version`)
   - Jira version
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages/logs

### Suggesting Features

1. Open an issue with the "feature request" label
2. Describe the use case and expected behavior
3. Explain why this would benefit other users

### Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Test your changes locally
5. Submit a pull request

#### PR Guidelines

- Keep changes focused and atomic
- Follow existing code style
- Update documentation if needed
- Add tests for new functionality
- Ensure all tests pass

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/jira-mcp-server.git
cd jira-mcp-server

# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev
```

## Testing

Before submitting a PR, ensure:

1. The project builds without errors: `npm run build`
2. The server starts correctly: `npm start`
3. Your changes work with a real Jira instance (if possible)

## Code Style

- Use TypeScript
- Follow existing patterns in the codebase
- Use meaningful variable and function names
- Add comments for complex logic

## Questions?

Feel free to open an issue for any questions about contributing.
