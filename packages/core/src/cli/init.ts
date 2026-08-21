#!/usr/bin/env node
import { createProgram } from "./program.ts";

await createProgram().parseAsync(process.argv);
