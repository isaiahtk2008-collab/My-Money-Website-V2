# My-Money-Website-V2
This is a website that I can use to track my own personal expenses

## Security notes

- **This repo holds demo data only.** The numbers in `index.html` are made up. Your real numbers load from your Google Sheet after you sign in. Never paste real sheet data into this repo.
- **Your sheet script is the real gate.** `apps-script.gs` verifies your Google sign-in with Google, then hands this device a session key. Without a key it returns nothing and accepts no changes. Signing in on the page alone does not unlock real data.
- **Keep a private copy of the script for your own secrets.** If you set the optional `SECRET` word, put it only in the copy you paste into Apps Script (name it `*.PRIVATE.gs`; git ignores that name). Never commit it.
- To sign every device out at once, run `revokeAllSessions()` from the Apps Script editor.
