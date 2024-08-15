#!/usr/bin/env bash

# Fix incorrect base path for links from index page
perl -i -pe 's/\(docs\//(api_reference\//' pages/api_reference.mdx

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
find pages/api_reference -type f -exec perl -i -pe 's/^> (?!(`optional` )?\*\*\w+\*\*: `(?!object)\w+`(\[\])?\n).*\n//; s/^(#+) (Returns|Defined in|Parameters|Properties|Type declaration|Extends|Overrides)/"<h" . length($1) . " className=\"nx-font-semibold nx-tracking-tight nx-text-slate-900 dark:nx-text-slate-100 nx-mt-8 nx-text-" . (length($1) > 3 ? "lg" : "2xl") . "\">" . $2 . "<\/h" . length($1) . ">"/eg' {} +

# Fix tables missing tbody, see https://github.com/typedoc2md/typedoc-plugin-markdown/issues/671
# Apply table styles.
find pages/api_reference -type f -exec perl -i -0777 -pe 's/<table>/<table className="api_reference_table"><tbody>/g; s#</table>#</tbody></table>#g' {} \;

# Make absolute links relative so they open in the same tab
# and on localhost.
find pages/api_reference -type f -exec perl -i -pe 's#https://labs.convex.dev/auth##g' {} +
