// Reader Playground for VS Code: the Reader Companion's projects in a side
// bar, the papers a project cites (and its ¶ citations as links), the
// Companion's state in the status bar, and the project's Python picked for
// you. It keeps no state of its own: the folder on disk and the Companion's
// settings are the truth, and the site is one click away. See docs/companion.md.

import path from 'node:path';
import * as vscode from 'vscode';
import type { Companion, Marker, Project } from './companion';
import { findCitations, interpreterOf, listProjects, ping, projectFolderOf, readCompanion, readMarker, startCommand } from './companion';

let companion: Companion;
let running: string | null = null;

const siteSetting = () => vscode.workspace.getConfiguration('reader').get<string>('site') || 'https://saurav717.github.io/reader/';

// ------------------------------------------------------------- the trees --

class ProjectItem extends vscode.TreeItem {
  constructor(readonly project: Project) {
    super(project.marker?.title ?? project.name, vscode.TreeItemCollapsibleState.None);
    const open = vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === project.folder);
    this.description = open ? 'open' : project.marker ? '' : 'not on the site';
    this.tooltip = new vscode.MarkdownString(`**${project.marker?.title ?? project.name}**\n\n\`${project.folder}\`${project.marker?.cites.length ? `\n\nCites: ${project.marker.cites.map((c) => c.title).join(', ')}` : ''}`);
    this.iconPath = new vscode.ThemeIcon(open ? 'folder-opened' : 'folder');
    this.contextValue = project.marker ? 'project.onSite' : 'project';
    this.command = { command: 'reader.openProject', title: 'Open Project', arguments: [this] };
  }
}

class ProjectsTree implements vscode.TreeDataProvider<ProjectItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh = () => this.changed.fire();
  getTreeItem = (item: ProjectItem) => item;
  async getChildren(): Promise<ProjectItem[]> {
    return (await listProjects(companion)).map((project) => new ProjectItem(project));
  }
}

class PaperItem extends vscode.TreeItem {
  constructor(readonly cite: Marker['cites'][number]) {
    super(cite.title, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('book');
    this.tooltip = `Open “${cite.title}” on the site`;
    this.command = { command: 'reader.openPaper', title: 'Open the Paper', arguments: [cite.page] };
  }
}

class PapersTree implements vscode.TreeDataProvider<PaperItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh = () => this.changed.fire();
  getTreeItem = (item: PaperItem) => item;
  async getChildren(): Promise<PaperItem[]> {
    const marker = await currentMarker();
    return (marker?.cites ?? []).map((cite) => new PaperItem(cite));
  }
}

class CompanionTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  refresh = () => this.changed.fire();
  getTreeItem = (item: vscode.TreeItem) => item;
  getChildren(): vscode.TreeItem[] {
    const row = (label: string, description: string, icon: string, command?: vscode.Command) => Object.assign(new vscode.TreeItem(label), { description, iconPath: new vscode.ThemeIcon(icon), command });
    if (running === null) {
      return [
        row('Not running', `127.0.0.1:${companion.port}`, 'circle-outline'),
        row('Start the Companion', 'in a terminal here', 'play', { command: 'reader.start', title: 'Start' }),
      ];
    }
    return [
      row('Running', `127.0.0.1:${companion.port}${running ? ` · Jupyter ${running}` : ''}`, 'pass-filled'),
      row('Folder', companion.root, 'folder'),
      row('Python', interpreterOf(companion), 'symbol-namespace'),
      ...(companion.config.tunnel ? [row('Tunnel', 'on, for Safari', 'globe')] : []),
      row('Open the Playground', companion.site, 'link-external', { command: 'reader.openPlayground', title: 'Open' }),
    ];
  }
}

// --------------------------------------------------------------- helpers --

/** The Reader project the open folder or the active file is in, if any. */
function currentFolder(): string | null {
  const file = vscode.window.activeTextEditor?.document.uri;
  if (file?.scheme === 'file') {
    const found = projectFolderOf(companion, file.fsPath);
    if (found) return found;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const found = projectFolderOf(companion, folder.uri.fsPath + path.sep);
    if (found) return found;
  }
  return null;
}

async function currentMarker(): Promise<Marker | null> {
  const folder = currentFolder();
  return folder ? readMarker(folder) : null;
}

/** In a Reader project, the Python extension uses the Companion's environment, unless a Python was already chosen there. */
async function pickInterpreter(ask: boolean) {
  if (!vscode.workspace.getConfiguration('reader').get<boolean>('setPythonInterpreter') && !ask) return;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!projectFolderOf(companion, folder.uri.fsPath + path.sep)) continue;
    const python = vscode.workspace.getConfiguration('python', folder.uri);
    const chosen = python.inspect<string>('defaultInterpreterPath');
    if (!ask && (chosen?.workspaceFolderValue || chosen?.workspaceValue)) continue;
    await python.update('defaultInterpreterPath', interpreterOf(companion), vscode.ConfigurationTarget.WorkspaceFolder);
    if (ask) void vscode.window.showInformationMessage(`This project now uses ${interpreterOf(companion)} — the same Python as the site's terminal and notebooks.`);
  }
}

// ------------------------------------------------------------- activate --

export async function activate(context: vscode.ExtensionContext) {
  companion = await readCompanion(siteSetting());
  const projects = new ProjectsTree();
  const papers = new PapersTree();
  const state = new CompanionTree();
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  const look = async () => {
    companion = await readCompanion(siteSetting());
    running = await ping(companion);
    await vscode.commands.executeCommand('setContext', 'reader.running', running !== null);
    bar.text = running !== null ? `$(pass-filled) Reader: ${companion.config.name ?? 'this computer'}` : '$(circle-outline) Reader';
    bar.tooltip = running !== null ? `The Reader Companion is running on 127.0.0.1:${companion.port}. Click to open this project on the site.` : 'The Reader Companion isn’t running. Click to start it.';
    bar.command = running !== null ? 'reader.openOnSite' : 'reader.start';
    bar.show();
    projects.refresh();
    state.refresh();
  };

  context.subscriptions.push(
    bar,
    vscode.window.registerTreeDataProvider('reader.projects', projects),
    vscode.window.registerTreeDataProvider('reader.papers', papers),
    vscode.window.registerTreeDataProvider('reader.companion', state),
    vscode.commands.registerCommand('reader.refresh', look),
    vscode.commands.registerCommand('reader.openPlayground', () => vscode.env.openExternal(vscode.Uri.parse(`${companion.site}playground`))),
    vscode.commands.registerCommand('reader.openPaper', (page: string) => vscode.env.openExternal(vscode.Uri.parse(page))),
    vscode.commands.registerCommand('reader.openProject', async (item?: ProjectItem) => {
      const folder = item?.project.folder;
      if (!folder) return;
      const uri = vscode.Uri.file(folder);
      // An empty window takes the project; a window with a folder keeps it and opens a new one.
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: Boolean(vscode.workspace.workspaceFolders?.length) });
    }),
    vscode.commands.registerCommand('reader.openOnSite', async (item?: ProjectItem) => {
      const marker = item?.project.marker ?? (await currentMarker());
      await vscode.env.openExternal(vscode.Uri.parse(marker?.page ?? `${companion.site}playground`));
    }),
    vscode.commands.registerCommand('reader.useEnvironment', () => pickInterpreter(true)),
    vscode.commands.registerCommand('reader.start', async () => {
      const existing = vscode.window.terminals.find((t) => t.name === 'Reader Companion');
      if (existing) return existing.show();
      const terminal = vscode.window.createTerminal({ name: 'Reader Companion', iconPath: new vscode.ThemeIcon('plug') });
      terminal.show();
      terminal.sendText(startCommand(companion.site, process.platform, Boolean(companion.config.tunnel)));
      // Look again until it answers, for a minute or two: the first run installs things.
      for (let i = 0; i < 60 && running === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await look();
      }
      if (running !== null && !companion.config.token) void vscode.window.showInformationMessage('The Companion is running. Pair a browser with it from the Playground’s Connect this computer card.');
    }),
    // ¶ citations in the project's files become links to the paper on the site.
    vscode.languages.registerDocumentLinkProvider({ scheme: 'file' }, {
      async provideDocumentLinks(document) {
        const folder = projectFolderOf(companion, document.uri.fsPath);
        const marker = folder ? await readMarker(folder) : null;
        if (!marker?.cites.length) return [];
        const links: vscode.DocumentLink[] = [];
        for (let line = 0; line < Math.min(document.lineCount, 5000); line += 1) {
          for (const found of findCitations(document.lineAt(line).text, marker.cites)) {
            const link = new vscode.DocumentLink(new vscode.Range(line, found.start, line, found.end), vscode.Uri.parse(found.cite.page));
            link.tooltip = `Open “${found.cite.title}”${found.place ? ` at ${found.place}` : ''} on the site`;
            links.push(link);
          }
        }
        return links;
      },
    }),
    vscode.window.onDidChangeActiveTextEditor(() => papers.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => (projects.refresh(), papers.refresh(), void pickInterpreter(false))),
    vscode.workspace.onDidChangeConfiguration((event) => event.affectsConfiguration('reader') && void look()),
  );

  // The folder changes when the site makes or deletes a project; the settings when the Companion runs.
  const watchers = [
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(companion.root, 'playgrounds')), '*/.reader/playground.json')),
    vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(companion.root, 'playgrounds')), '*')),
  ];
  for (const watcher of watchers) {
    context.subscriptions.push(watcher, watcher.onDidCreate(() => (projects.refresh(), papers.refresh())), watcher.onDidDelete(() => projects.refresh()), watcher.onDidChange(() => papers.refresh()));
  }
  const timer = setInterval(() => void look(), 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  await look();
  await pickInterpreter(false);
}

export function deactivate() {
  // nothing held open
}
