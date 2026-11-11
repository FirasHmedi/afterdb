#!/usr/bin/env bash
# New app from the CLI template of the newest React Native 0.88.x release, with the example's App.tsx and
# schema.ts, "realm" and "@realm/react" set to $REALM_ALIAS and $REACT_ALIAS (the npm alias lines of the README),
# then npm install. Writes app-id (the Android applicationId) to $GITHUB_OUTPUT when it is set.
# Usage (from the repository root): REALM_ALIAS=... REACT_ALIAS=... scripts/registry-new-app.sh <AppName>
set -euo pipefail
NAME="$1"
: "${REALM_ALIAS:?}" "${REACT_ALIAS:?}"
RN=$(npm view 'react-native@>=0.88.0 <0.89.0' version --json | node -e '
  const v = [].concat(JSON.parse(require("fs").readFileSync(0, "utf8")));
  v.sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]));
  console.log(v[v.length - 1]);
')
echo "React Native $RN (newest 0.88.x on npm), CLI $(npm view @react-native-community/cli@latest version)"
# the CLI refuses dots in project names; --version picks the template of that React Native version
npx --yes @react-native-community/cli@latest init "$NAME" --version "$RN" --skip-git-init --install-pods false --skip-install
cp example/App.tsx example/schema.ts "$NAME/"
(
  cd "$NAME"
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    p.dependencies.realm = process.env.REALM_ALIAS;
    p.dependencies["@realm/react"] = process.env.REACT_ALIAS;
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
    console.log(JSON.stringify(p.dependencies, null, 2));
  '
  npm install --no-audit --no-fund
  got=$(node -p 'require("./node_modules/react-native/package.json").version')
  [ "$got" = "$RN" ] || { echo "::error::react-native is $got, not $RN"; exit 1; }
)
id=$(sed -n 's/^ *applicationId *"\([^"]*\)".*/\1/p' "$NAME/android/app/build.gradle" | head -1)
echo "applicationId: $id"
[ -n "$id" ] || { echo "::error::no applicationId in $NAME/android/app/build.gradle"; exit 1; }
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "app-id=$id" >> "$GITHUB_OUTPUT"; fi
