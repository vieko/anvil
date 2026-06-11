import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "./run.ts";

// The bundled skill content ships alongside the package (package.json "files").
// Both the built `dist/` and the dev `src/` sit one level under the package
// root, so this resolves in either layout — and, crucially, the *installed*
// binary serves it, so the guide an agent reads always matches the running
// version. A static SKILL.md registered with a harness would freeze and drift.
const SKILL_DATA = fileURLToPath(new URL("../skill-data", import.meta.url));

interface SkillMeta {
	name: string;
	description: string;
}

/** Pull a single-line value (e.g. `description`) from a SKILL.md YAML frontmatter block. */
function frontmatterValue(md: string, key: string): string {
	const block = md.match(/^---\n([\s\S]*?)\n---/)?.[1];
	if (!block) return "";
	for (const line of block.split("\n")) {
		const sep = line.indexOf(":");
		if (sep > 0 && line.slice(0, sep).trim() === key) return line.slice(sep + 1).trim();
	}
	return "";
}

/** Bundled skills, discovered from `skill-data/<name>/SKILL.md`, sorted by name. */
async function discover(): Promise<SkillMeta[]> {
	const entries = await readdir(SKILL_DATA, { withFileTypes: true }).catch(() => []);
	const skills: SkillMeta[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const md = await readFile(join(SKILL_DATA, entry.name, "SKILL.md"), "utf8").catch(() => null);
		if (md === null) continue;
		skills.push({ name: entry.name, description: frontmatterValue(md, "description") });
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Concatenated `references/*.md` for a skill (sorted), or [] when there are none. */
async function references(skillDir: string): Promise<{ name: string; body: string }[]> {
	const dir = join(skillDir, "references");
	const files = await readdir(dir).catch(() => [] as string[]);
	const out: { name: string; body: string }[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(".md")) continue;
		const body = await readFile(join(dir, file), "utf8").catch(() => null);
		if (body !== null) out.push({ name: file, body });
	}
	return out;
}

/**
 * Serve anvil's bundled, version-matched agent guide.
 *
 *   anvil skills list                 # what's available
 *   anvil skills get [name=core]      # print a skill's guide
 *   anvil skills get core --full      # also append its reference material
 *
 * The content ships with the binary, so an agent that runs `anvil skills get
 * core` always reads instructions that match the installed version.
 */
export async function executeSkills(
	action: "list" | "get",
	name: string | undefined,
	full: boolean,
	io: Io,
): Promise<number> {
	if (action === "list") {
		const skills = await discover();
		if (skills.length === 0) {
			io.out("no skills bundled");
			return 0;
		}
		const width = Math.max(...skills.map((s) => s.name.length));
		for (const s of skills) io.out(`${s.name.padEnd(width)}  ${s.description}`);
		return 0;
	}

	const skillName = name ?? "core";
	const skillDir = join(SKILL_DATA, skillName);
	const md = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => null);
	if (md === null) {
		io.err(`anvil: no bundled skill "${skillName}" (try: anvil skills list)`);
		return 1;
	}
	io.out(md);
	if (full) {
		for (const ref of await references(skillDir)) {
			io.out(`\n---\n\n<!-- reference: ${ref.name} -->\n`);
			io.out(ref.body);
		}
	}
	return 0;
}
