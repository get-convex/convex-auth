This is Convex Auth, an authentication framework built on top of Convex.

Because it's a framework, some guidelines that are specific to building apps might not apply. However, much of the guidance you'll receive about Convex development is spot on.

Just watch out for things like the location of the `convex/` folder and other stuff that might vary between a framework that is meant to be used with a Convex app and a Convex app itself.

This is actually a new start for Convex Auth - commit b6cf31f06201062cbd86687f5da1a1434dcb660c marks the (likely) last checkpoint of the old system. You may or may not see the old system in the codebase, depending on what stage of development we're at. You can reference files at that commit if you want to look back at the old system.

The new version will be built with Convex components and no longer depend on NextAuth/Auth.js. For OAuth, we'll use Artic providers. Other providers will be written and supported directly by us. Each provider will be a component. We'll start with a minimal core framework and a few provider components and build up to something fully functional.

We want to keep some parity with the existing Convex Auth here, like offering builtin support for React and Next.js. But it should be built on foundations that allow other client side and server side frameworks to integrate as well.

A lot of ideas for the new Convex Auth have been explored in the prototype/ submodule. We'll likely refer to that for building out various pieces here.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
