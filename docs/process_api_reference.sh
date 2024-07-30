#!/usr/bin/env bash

# Delete the GenericDoc docs, because they cannot
# be reordered but show up first in server.
perl -i -0777 -pe 's/\n## GenericDoc.*?\*\*\*\n//gs' pages/api_reference/server.mdx
  
# h5 Type Declaration is only used for schema fields, replace
# it with a table header.
perl -i -pe 's/^##### (Type declaration)/|Field|TS Type\n|---|---/g' pages/api_reference/server.mdx

# Fields are h6, turn them into table rows
perl -i -0777 -pe 's/\n###### ([^\n]+)\n\n> \*\*[^*]+\*\*:/|`$1`| /g' pages/api_reference/server.mdx

# Remove type parameters, they're not helpful
find pages/api_reference -type f -exec perl -i -0777 -pe 's/\n(#+) Type Parameters(.(?!###))*//sg' {} +

# Remove complicated signatures, we document them where applicable.
#
# Also by rewriting the markdown headings to HTML we prevent Nextra from
# including them in the RHS TOC sidebar.
find pages/api_reference -type f -exec perl -i -pe 's/^> (?!(`optional` )?\*\*\w+\*\*: `(?!object)\w+`(\[\])?\n).*\n//; s/^(#+) (Returns|Defined in|Parameters|Properties|Type declaration|Extends|Overrides)/"<h" . length($1) . " class=\"nx-font-semibold nx-tracking-tight nx-text-slate-900 dark:nx-text-slate-100 nx-mt-8 nx-text-" . (length($1) > 3 ? "lg" : "2xl") . "\">" . $2 . "<\/h" . length($1) . ">"/eg' {} +
