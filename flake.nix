{
  description = "pi-reflect development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "pi-reflect";
            packages = with pkgs; [
              nodejs_24
              typescript
              git
            ];
            shellHook = ''
              echo "pi-reflect dev shell"
              echo "  node: $(node --version)"
              echo "  tsc:  $(tsc --version)"
            '';
          };
        }
      );
    };
}
