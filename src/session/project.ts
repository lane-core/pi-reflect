const USER = process.env.USER ?? "user";

export function projectNameFromDir(dirname: string): string {
	let name = dirname;
	const homePrefix = `--Users-${USER}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	const linuxPrefix = `--home-${USER}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}
