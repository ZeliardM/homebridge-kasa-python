import ts from 'typescript';
import KasaPythonPlatform from './platform.js';

export class EnumParser {
  constructor(private platform: KasaPythonPlatform) {}

  private parseConstEnum(sourceFile: ts.SourceFile) {
    const enums: Record<string, { value: number; name: string }[]> = {};

    const visit = (node: ts.Node) => {
      if (
        ts.isEnumDeclaration(node) &&
        node.name.text === 'Categories' &&
        node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ConstKeyword)
      ) {
        const enumName = node.name.text;
        enums[enumName] = node.members.map(member => ({
          value: member.initializer && ts.isNumericLiteral(member.initializer) ? Number(member.initializer.text) : 0,
          name: ts.isIdentifier(member.name) ? member.name.text : '',
        }));
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return enums;
  }

  private generateEnumObject(enums: Record<string, { value: number; name: string }[]>) {
    return Object.values(enums).reduce((acc, members) => {
      members.forEach(member => {
        acc[member.value] = member.name;
      });
      return acc;
    }, {} as Record<number, string>);
  }

  public parse() {
    const fileToParse = `${this.platform.storagePath}/node_modules/homebridge/node_modules/hap-nodejs/dist/lib/Accessory.d.ts`;
    const program = ts.createProgram([fileToParse], {});
    const sourceFile = program.getSourceFile(fileToParse);

    if (!sourceFile) {
      this.platform.log.error('Source file not found.');
      return null;
    }

    const enums = this.parseConstEnum(sourceFile);
    return this.generateEnumObject(enums);
  }
}