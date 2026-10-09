// Builds the Reader Playground extension for VS Code (vscode/) into a .vsix,
// for the site to serve and for "Install from VSIX…".
//   node scripts/build-vscode.mjs <outDir>
// writes <outDir>/vscode/reader-playground-<version>.vsix and
// <outDir>/vscode/reader-playground.vsix (the same file, at a name that always
// means the newest). esbuild bundles vscode/src/extension.ts into one file; the
// .vsix is a zip of it with its manifest, the way @vscode/vsce lays one out,
// made with the Companion's zip writer so a rebuild is byte-for-byte the same.
// To publish to the Marketplace instead: cd vscode && npx @vscode/vsce publish.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zip } from './build-companion.mjs';
import { themeFiles } from './vscode-themes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'vscode');

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** extension.vsixmanifest for this package.json, as vsce writes it. */
export function vsixManifest(pkg, { icon, readme }) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName ?? pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description ?? '')}</Description>
    <Tags>${xml((pkg.keywords ?? []).join(','))}</Tags>
    <Categories>${xml((pkg.categories ?? []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
${repo ? `      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(repo)}" />\n      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${xml(repo)}" />\n` : ''}${pkg.homepage ? `      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${xml(pkg.homepage)}" />\n` : ''}    </Properties>
${icon ? `    <Icon>extension/${xml(icon)}</Icon>\n` : ''}  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
${readme ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />\n' : ''}${icon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(icon)}" Addressable="true" />\n` : ''}  </Assets>
</PackageManifest>
`;
}

const TYPES = { '.json': 'application/json', '.js': 'application/javascript', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml', '.vsixmanifest': 'text/xml', '.txt': 'text/plain' };

export function contentTypes(names) {
  const used = [...new Set(names.map((name) => name.slice(name.lastIndexOf('.'))))].filter((ext) => TYPES[ext]).sort();
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${used.map((ext) => `<Default Extension="${ext}" ContentType="${TYPES[ext]}" />`).join('')}</Types>
`;
}

/** The .vsix's name and bytes, from vscode/. */
export async function buildVsix(dir = source) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const bundled = await build({
    entryPoints: [join(dir, 'src', 'extension.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    write: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const files = [['extension/package.json', Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`)], ['extension/dist/extension.js', Buffer.from(bundled.outputFiles[0].contents)]];
  // The themes come from the site's stylesheet, so they are made fresh here, not read from vscode/themes/.
  for (const [name, text] of Object.entries(themeFiles())) files.push([`extension/${name}`, Buffer.from(text)]);
  for (const extra of ['README.md', 'CHANGELOG.md', 'media/reader.svg', pkg.icon]) {
    if (extra && existsSync(join(dir, extra)) && !files.some(([name]) => name === `extension/${extra}`)) files.push([`extension/${extra}`, readFileSync(join(dir, extra))]);
  }
  const icon = pkg.icon && existsSync(join(dir, pkg.icon)) ? pkg.icon : null;
  const readme = existsSync(join(dir, 'README.md'));
  const manifest = Buffer.from(vsixManifest(pkg, { icon, readme }));
  const all = [['extension.vsixmanifest', manifest], ...files];
  const entries = [['[Content_Types].xml', Buffer.from(contentTypes(all.map(([name]) => name)))], ...all];
  return { name: `${pkg.name}-${pkg.version}.vsix`, latest: `${pkg.name}.vsix`, version: pkg.version, bytes: zip(entries) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/build-vscode.mjs <outDir>');
    process.exit(2);
  }
  const built = await buildVsix();
  mkdirSync(join(out, 'vscode'), { recursive: true });
  writeFileSync(join(out, 'vscode', built.name), built.bytes);
  writeFileSync(join(out, 'vscode', built.latest), built.bytes);
  console.log(`vscode ${built.version}: ${join(out, 'vscode', built.name)} (${built.bytes.length} bytes) and ${built.latest}`);
}
