import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-balance">Restaurant Ordering System</h1>
        <p className="text-muted-foreground text-lg">Choose a screen to preview</p>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-md">
        <Button asChild size="lg" className="w-full">
          <Link href="/menu">Customer Menu</Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="w-full bg-transparent">
          <Link href="/dashboard">Order Dashboard</Link>
        </Button>
      </div>
    </div>
  )
}
