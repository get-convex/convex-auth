#!/bin/bash

# Store the current directory
current_dir=$(pwd)

# Get the directory of the script
script_dir=$(dirname "$(realpath "${BASH_SOURCE[0]}")")

# Change directory to the script directory
cd "$script_dir" || exit 1

# Run TypeScript compiler
npm run build:bin > /dev/null

# Return to the original directory
cd "$current_dir" || exit 1

# Run the generated .cjs file with Node.js
node "$script_dir"/dist/bin.cjs "$@"