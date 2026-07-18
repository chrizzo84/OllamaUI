import { redirect } from 'next/navigation';

// Playground was merged into Chat as a "Compare" mode — two columns sharing
// one composer, running through the same tool-calling/thinking pipeline
// instead of a separate, duplicated implementation.
export default function PlaygroundRedirect() {
  redirect('/chat?compare=1');
}
