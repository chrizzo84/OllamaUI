import Link from 'next/link';

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.014-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}
import packageJson from '../../package.json';

export function SiteFooter() {
  const year = new Date().getFullYear();
  const appVersion = packageJson.version;
  return (
    <footer className="mt-10 border-t border-white/10 px-6 py-4 text-[11px] text-white/60 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-4 text-center">
      <span className="whitespace-nowrap">© {year} chrizzo84</span>
      <span className="hidden sm:inline text-white/30">•</span>
      <span className="font-mono text-white/40">v{appVersion}</span>
      <Link
        href="https://github.com/chrizzo84"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 hover:text-white transition-colors"
        aria-label="GitHub Profile chrizzo84"
      >
        <GithubIcon className="h-4 w-4" aria-hidden="true" />
        <span>Profile</span>
      </Link>
      <span className="hidden sm:inline text-white/30">•</span>
      <Link
        href="https://github.com/chrizzo84/OllamaUI"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 hover:text-white transition-colors"
        aria-label="Repository OllamaUI"
      >
        <GithubIcon className="h-4 w-4" aria-hidden="true" />
        <span>Repo</span>
      </Link>
    </footer>
  );
}
