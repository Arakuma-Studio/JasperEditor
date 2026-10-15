/** ssh shim: drops ssh options, takes the target, runs the rest as a local shell command. */
export const SSH_SHIM = `#!/usr/bin/env bash
args=("$@"); i=0; n=\${#args[@]}
while [ $i -lt $n ]; do
  a="\${args[$i]}"
  case "$a" in
    -o|-p|-i|-P|-l|-F) i=$((i+2));;
    -*) i=$((i+1));;
    *) break;;
  esac
done
i=$((i+1))
cmd="\${args[*]:$i}"
exec bash -c "$cmd"
`;
