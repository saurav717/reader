# Reader Playground for VS Code

Your [Reader](https://saurav717.github.io/reader/playground) playgrounds in VS
Code. A project you make on the site, on **This computer**, is a plain folder
that the Reader Companion keeps in `~/Reader/playgrounds/<name>`. This
extension shows those folders, the papers each one cites and the Companion's
state, and it uses the same Python as the site.

## What it does

- **Projects:** the **Reader** side bar lists the Companion's projects. Click
  one to open its folder. **Open on the site** opens its page in the browser,
  with the notebook, Metrics and the papers.
- **Papers it cites:** this view shows the open project's papers. A `¶ Title
  §3.1` citation in a file becomes a link to that paper on the site.
- **The same Python:** in a Reader project, the Python extension uses the
  Companion's environment (`~/Reader/.venv`, or the one given with
  `--python`). Notebooks, the terminal and the site's terminal then run the
  same interpreter with the same packages. **Reader: Use the Companion's Python
  for This Project** sets it again if you changed it, and
  `reader.setPythonInterpreter` turns the automatic choice off.
- **The site's look:** **Reader Light** and **Reader Dark** colour themes use
  the site's paper, ink, accent and code colours, made from its own
  stylesheet. Pick one with **Reader: Use the Site's Look**, or under
  **Preferences → Color Theme**.
- **The Companion:** the status bar says whether it's running.
  **Reader: Start the Companion** starts it in a terminal here, with the same
  command the site's **Connect this computer** card gives.

It keeps no state of its own. The folder on disk and the Companion's settings
(`~/.reader-companion/config.json`) are the truth, so VS Code, the site and any
other editor always agree.

## Install

From the site: **Playground → Connect this computer → VS Code**. Or:

```bash
curl -LsSfo /tmp/reader-playground.vsix https://saurav717.github.io/reader/vscode/reader-playground.vsix
code --install-extension /tmp/reader-playground.vsix
```

or **Extensions → … → Install from VSIX…** with that file.
