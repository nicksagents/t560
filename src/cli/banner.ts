type BannerOptions = {
  version: string;
};

const T560_ASCII = [
"████████╗ ███████╗ ██████╗  ██████╗ ",
"╚══██╔══╝ ██╔════╝██╔════╝ ██╔═████╗",
"   ██║    ███████╗███████╗ ██║██╔██║",
"   ██║    ╚════██║██╔═══██╗████╔╝██║",
"   ██║    ███████║╚██████╔╝╚██████╔╝",
"   ╚═╝    ╚══════╝ ╚═════╝  ╚═════╝ ",
" ",
"        ⚡ T560 NEURAL CORE ⚡",
" ",
];


function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function color(text: string, code: string): string {
  if (!supportsColor()) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function formatArt(): string {
  if (!supportsColor()) {
    return T560_ASCII.join("\n");
  }
  return T560_ASCII.map((line) => color(line, "36")).join("\n");
}

export function printBanner(options: BannerOptions): void {
  const title = color("T560", "1;96");
  const version = color(options.version, "1;37");
  const status = color("mini scaffold runtime", "2;37");
  process.stdout.write(`\n${formatArt()}\n`);
  process.stdout.write(`${title} ${version} - ${status}\n\n`);
}
