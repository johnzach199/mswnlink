# Apply the mswnlink light/dark theme toggle

This update adds a button to the top-right corner of the app. It switches between Light mode and Dark mode and stores the chosen appearance locally, so the selection is remembered after restarting the app.

## Update an existing source repository

Replace these files at the repository root:

- `index.html`
- `styles.css`
- `renderer.js`

Commit and push the changes to your `main` branch, then rebuild the executable packages with your existing GitHub Actions workflow.

## Run locally

From the project folder, run `npm install` and `npm start` (Node.js 22.12 or later is required by this project).
