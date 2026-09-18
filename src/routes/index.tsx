import { createFileRoute } from "@tanstack/react-router";
import { BrigadeApp } from "@/components/brigade-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <BrigadeApp />;
}
