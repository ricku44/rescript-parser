/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 */

class ReScriptParser {
  constructor(input, options = {}) {
    if (typeof input !== 'string') {
      throw new Error('Input must be a string');
    }
    
    this.input = input;
    this.filename = options.filename;
    this.position = 0;
    this.lines = input.split('\n');
    this.errors = [];
    this.sourceLength = input.length;
  }

  parse() {
    try {
      const lineCount = this.lines.length;
      const endColumn = this.lines[lineCount - 1]?.length || 0;
      
      return {
        type: 'Program',
        loc: {
          source: this.filename,
          start: { line: 1, column: 0 },
          end: { line: lineCount, column: endColumn }
        },
        body: this.parseProgram(),
        comments: [],
        interpreter: null,
        range: [0, this.sourceLength],
        sourceType: 'module',
        docblock: null
      };
    } catch (error) {
      this.addError(`Parse error: ${error.message}`, 0);
      return this.createErrorProgram();
    }
  }

  createErrorProgram() {
    return {
      type: 'Program',
      loc: {
        source: this.filename,
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 }
      },
      body: [],
      comments: [],
      interpreter: null,
      range: [0, 0],
      sourceType: 'module',
      docblock: null,
      errors: this.errors
    };
  }

  addError(message, position) {
    const line = this.getLineNumber(position);
    const column = this.getColumnNumber(position);
    
    this.errors.push({
      message,
      line,
      column,
      position
    });
  }

  createLoc(startLine, startCol, endLine, endCol) {
    const maxLine = this.lines.length;
    const safeStartLine = Math.max(1, Math.min(startLine, maxLine));
    const safeEndLine = Math.max(1, Math.min(endLine, maxLine));
    const safeStartCol = Math.max(0, startCol);
    const safeEndCol = Math.max(0, endCol);
    
    return {
      source: this.filename,
      start: { line: safeStartLine, column: safeStartCol },
      end: { line: safeEndLine, column: safeEndCol }
    };
  }

  createRange(start, end) {
    const safeStart = Math.max(0, Math.min(start, this.sourceLength));
    const safeEnd = Math.max(safeStart, Math.min(end, this.sourceLength));
    return [safeStart, safeEnd];
  }

  parseProgram() {
    const statements = [];
    
    try {
      this.parseOpenStatements(statements);
      this.parseTypeDefinitions(statements);
      this.parseLetStatements(statements);
      this.parseCodegenCalls(statements);
    } catch (error) {
      this.addError(`Program parsing error: ${error.message}`, 0);
    }
    
    return statements;
  }

  parseOpenStatements(statements) {
    try {
      const openTurboMatch = this.input.match(/open\s+TurboModule/);
      if (openTurboMatch) {
        const statement = this.createOpenStatement(openTurboMatch, 'TurboModule', 'type');
        if (statement) statements.push(statement);
      }

      const openCodegenMatch = this.input.match(/open\s+CodegenNativeComponent/);
      if (openCodegenMatch) {
        const statement = this.createOpenStatement(openCodegenMatch, 'codegenNativeComponent', 'value');
        if (statement) statements.push(statement);
      }
    } catch (error) {
      this.addError(`Open statement parsing error: ${error.message}`, 0);
    }
  }

  createOpenStatement(match, importName, importKind) {
    try {
      const startPos = this.input.indexOf(match[0]);
      if (startPos === -1) return null;
      
      const endPos = startPos + match[0].length;
      const startLine = this.getLineNumber(startPos);
      const endLine = this.getLineNumber(endPos);
      
      return {
        type: 'ImportDeclaration',
        loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
        range: this.createRange(startPos, endPos),
        specifiers: [{
          type: 'ImportSpecifier',
          loc: this.createLoc(startLine, this.getColumnNumber(startPos + 5), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos + 5, endPos),
          imported: { 
            type: 'Identifier', 
            name: importName,
            loc: this.createLoc(startLine, this.getColumnNumber(startPos + 5), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos + 5, endPos)
          },
          local: { 
            type: 'Identifier', 
            name: importName,
            loc: this.createLoc(startLine, this.getColumnNumber(startPos + 5), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos + 5, endPos)
          }
        }],
        source: {
          type: 'Literal',
          value: 'react-native',
          raw: "'react-native'",
          loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos, endPos)
        },
        importKind: importKind
      };
    } catch (error) {
      this.addError(`Error creating open statement: ${error.message}`, 0);
      return null;
    }
  }

  parseTypeDefinitions(statements) {
    try {
      const typeMatch = this.input.match(/type\s+(\w+)\s*=\s*\{([^}]+)\}/s);
      if (!typeMatch) return;
      
      const typeName = typeMatch[1];
      const typeBody = typeMatch[2];
      
      if (!typeName || !typeBody) {
        this.addError('Invalid type definition structure', 0);
        return;
      }
      
      const startPos = this.input.indexOf(typeMatch[0]);
      const endPos = startPos + typeMatch[0].length;
      const startLine = this.getLineNumber(startPos);
      const endLine = this.getLineNumber(endPos);

      const hasSpread = typeBody.includes('...turboModule') || typeBody.includes('...TurboModule.turboModule');
      const hasViewProps = typeBody.includes('...View.viewProps');
      
      // For component props, parse properties differently
      if (typeName === 'props' || hasViewProps) {
        const properties = this.parseComponentProps(typeBody);
        const statement = this.createTypeAliasStatement(typeName, properties, startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos), startPos, endPos);
        if (statement) statements.push(statement);
      } else {
        // For TurboModule specs, parse as interface
        const methods = this.parseMethodSignatures(typeBody);
        const statement = this.createInterfaceStatement(typeName, methods, hasSpread, startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos), startPos, endPos);
        if (statement) statements.push(statement);
      }
    } catch (error) {
      this.addError(`Type definition parsing error: ${error.message}`, 0);
    }
  }

  createTypeAliasStatement(typeName, properties, startLine, startCol, endLine, endCol, startPos, endPos) {
    try {
      return {
        type: 'ExportNamedDeclaration',
        loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
        range: this.createRange(startPos, endPos),
        declaration: {
          type: 'TypeAlias',
          loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos, endPos),
          id: { 
            type: 'Identifier', 
            name: typeName,
            loc: this.createLoc(startLine, this.getColumnNumber(startPos + 5), startLine, this.getColumnNumber(startPos + 5 + typeName.length)),
            range: this.createRange(startPos + 5, startPos + 5 + typeName.length)
          },
          right: {
            type: 'ObjectTypeAnnotation',
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos),
            properties: properties || [],
            typeParameters: {
              params: [
                {
                  properties: properties || []
                }
              ]
            }
          }
        },
        exportKind: 'type'
      };
    } catch (error) {
      this.addError(`Error creating type alias statement: ${error.message}`, startPos);
      return null;
    }
  }

  createInterfaceStatement(typeName, methods, hasSpread, startLine, startCol, endLine, endCol, startPos, endPos) {
    try {
      return {
        type: 'ExportNamedDeclaration',
        loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
        range: this.createRange(startPos, endPos),
        declaration: {
          type: 'InterfaceDeclaration',
          loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos, endPos),
          id: { 
            type: 'Identifier', 
            name: typeName.replace('spec', 'Spec'),
            loc: this.createLoc(startLine, this.getColumnNumber(startPos + 5), startLine, this.getColumnNumber(startPos + 5 + typeName.length)),
            range: this.createRange(startPos + 5, startPos + 5 + typeName.length)
          },
          extends: hasSpread ? [{
            type: 'InterfaceExtends',
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos),
            id: { 
              type: 'Identifier', 
              name: 'TurboModule',
              loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
              range: this.createRange(startPos, endPos)
            }
          }] : [],
          body: {
            type: 'ObjectTypeAnnotation',
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos),
            properties: methods || []
          }
        },
        exportKind: 'type'
      };
    } catch (error) {
      this.addError(`Error creating interface statement: ${error.message}`, startPos);
      return null;
    }
  }

  parseLetStatements(statements) {
    try {
      const letMatch = this.input.match(/let\s+(\w+).*=\s*(?:TurboModule\.)?get\("([^"]+)"\)/);
      if (!letMatch) return;
      
      const varName = letMatch[1];
      const moduleName = letMatch[2];
      
      if (!varName || !moduleName) {
        this.addError('Invalid let statement structure', 0);
        return;
      }
      
      const startPos = this.input.indexOf(letMatch[0]);
      const endPos = startPos + letMatch[0].length;
      const startLine = this.getLineNumber(startPos);
      const endLine = this.getLineNumber(endPos);

      const statement = {
        type: 'ExportDefaultDeclaration',
        loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
        range: this.createRange(startPos, endPos),
        declaration: {
          type: 'CallExpression',
          loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos, endPos),
          callee: {
            type: 'MemberExpression',
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos),
            object: {
              type: 'Identifier',
              name: 'TurboModuleRegistry',
              loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
              range: this.createRange(startPos, endPos)
            },
            property: {
              type: 'Identifier',
              name: 'get',
              loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
              range: this.createRange(startPos, endPos)
            },
            computed: false
          },
          arguments: [{
            type: 'Literal',
            value: moduleName,
            raw: `"${moduleName}"`,
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos)
          }],
          typeArguments: {
            type: 'TypeParameterInstantiation',
            params: [
              {
                type: 'GenericTypeAnnotation',
                id: {
                  name: 'Spec'
                }
              }
            ]
          }
        }
      };
      
      statements.push(statement);
    } catch (error) {
      this.addError(`Let statement parsing error: ${error.message}`, 0);
    }
  }

  parseCodegenCalls(statements) {
    try {
      const codegenMatch = this.input.match(/=\s*(?:CodegenNativeComponent\.)?codegenNativeComponent\("([^"]+)"/);
      if (!codegenMatch) return;
      
      const componentName = codegenMatch[1];
      
      if (!componentName) {
        this.addError('Invalid codegen component call structure', 0);
        return;
      }
      
      const startPos = this.input.indexOf(codegenMatch[0]);
      const endPos = startPos + codegenMatch[0].length;
      const startLine = this.getLineNumber(startPos);
      const endLine = this.getLineNumber(endPos);

      const statement = {
        type: 'ExportDefaultDeclaration',
        loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
        range: this.createRange(startPos, endPos),
        declaration: {
          type: 'CallExpression',
          loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
          range: this.createRange(startPos, endPos),
          callee: {
            type: 'Identifier',
            name: 'codegenNativeComponent',
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos)
          },
          arguments: [{
            type: 'Literal',
            value: componentName,
            raw: `"${componentName}"`,
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos)
          }],
          typeArguments: {
            type: 'TypeParameterInstantiation',
            params: [{
              type: 'GenericTypeAnnotation',
              id: {
                type: 'Identifier',
                name: 'props',
                loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
                range: this.createRange(startPos, endPos)
              },
              loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
              range: this.createRange(startPos, endPos)
            }],
            loc: this.createLoc(startLine, this.getColumnNumber(startPos), endLine, this.getColumnNumber(endPos)),
            range: this.createRange(startPos, endPos)
          }
        }
      };
      
      statements.push(statement);
    } catch (error) {
      this.addError(`Codegen call parsing error: ${error.message}`, 0);
    }
  }

  parseMethodSignatures(typeBody) {
    const methods = [];
    
    try {
      const lines = typeBody.split('\n').map(line => line.trim()).filter(line => line);
      let currentMethod = '';
      let methodName = '';
      let inMultiLineMethod = false;
      let parenDepth = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('...')) continue;
        
        const methodMatch = line.match(/^(\w+)\s*:\s*(.*)$/);
        if (methodMatch && !inMultiLineMethod) {
          if (currentMethod && methodName) {
            const methodProperty = this.createMethodFromSignature(methodName, currentMethod);
            if (methodProperty) methods.push(methodProperty);
          }
          
          methodName = methodMatch[1];
          currentMethod = methodMatch[2];
          
          parenDepth = (currentMethod.match(/\(/g) || []).length - (currentMethod.match(/\)/g) || []).length;
          inMultiLineMethod = parenDepth > 0;
          
        } else if (inMultiLineMethod) {
          currentMethod += ' ' + line;
          parenDepth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
          
          if (parenDepth <= 0) {
            inMultiLineMethod = false;
            currentMethod = currentMethod.replace(/,\s*$/, '');
          }
        }
      }
      
      if (currentMethod && methodName) {
        const methodProperty = this.createMethodFromSignature(methodName, currentMethod);
        if (methodProperty) methods.push(methodProperty);
      }
    } catch (error) {
      this.addError(`Method signature parsing error: ${error.message}`, 0);
    }
    
    return methods;
  }

  createMethodFromSignature(methodName, signature) {
    try {
      const { params, returnType } = this.parseTypeSignature(signature);
      return this.createMethodProperty(methodName, params, returnType);
    } catch (error) {
      this.addError(`Error creating method from signature: ${error.message}`, 0);
      return null;
    }
  }

  createMethodProperty(methodName, params, returnType) {
    try {
      return {
        type: 'ObjectTypeProperty',
        loc: this.createLoc(1, 0, 1, 0),
        range: this.createRange(0, 0),
        key: { 
          type: 'Identifier', 
          name: methodName,
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        },
        value: {
          type: 'FunctionTypeAnnotation',
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0),
          params: params || [],
          returnType: returnType || { type: 'VoidTypeAnnotation', loc: this.createLoc(1, 0, 1, 0), range: this.createRange(0, 0) }
        },
        method: true
      };
    } catch (error) {
      this.addError(`Error creating method property: ${error.message}`, 0);
      return null;
    }
  }

  parseTypeSignature(signature) {
    const params = [];
    let returnType = { type: 'VoidTypeAnnotation', loc: this.createLoc(1, 0, 1, 0), range: this.createRange(0, 0) };
    
    try {
      const complexFunctionMatch = signature.match(/\(\(([^)]*)\)\s*=>\s*([^)]+)\)\s*=>\s*(.+)/);
      if (complexFunctionMatch) {
        const callbackParamStr = complexFunctionMatch[1];
        const callbackReturnTypeStr = complexFunctionMatch[2].trim();
        const mainReturnTypeStr = complexFunctionMatch[3].trim();
        
        if (callbackParamStr.trim()) {
          const callbackParams = callbackParamStr.split(',').map(p => p.trim());
          callbackParams.forEach((param, index) => {
            const typeAnnotation = this.parseReScriptType(param);
            params.push({
              type: 'FunctionTypeParam',
              name: { 
                type: 'Identifier', 
                name: `param${index}`,
                loc: this.createLoc(1, 0, 1, 0),
                range: this.createRange(0, 0)
              },
              typeAnnotation: typeAnnotation,
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            });
          });
        }
        
        const callbackType = {
          type: 'FunctionTypeAnnotation',
          params: params,
          returnType: this.parseReScriptType(callbackReturnTypeStr),
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
        
        return {
          params: [{
            type: 'FunctionTypeParam',
            name: { 
              type: 'Identifier', 
              name: 'callback',
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            },
            typeAnnotation: callbackType,
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          }],
          returnType: this.parseReScriptType(mainReturnTypeStr)
        };
      }
      
      const multiParamMatch = this.extractFunctionSignature(signature);
      if (multiParamMatch) {
        const paramStr = multiParamMatch[1];
        const returnTypeStr = multiParamMatch[2].trim();
        
        const paramList = this.parseParameterList(paramStr);
        paramList.forEach((param, index) => {
          const typeAnnotation = this.parseReScriptType(param);
          params.push({
            type: 'FunctionTypeParam',
            name: { 
              type: 'Identifier', 
              name: `param${index}`,
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            },
            typeAnnotation: typeAnnotation,
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          });
        });
        
        returnType = this.parseReScriptType(returnTypeStr);
      } else {
        const arrowMatch = signature.match(/(.+)\s*=>\s*(.+)/);
        if (arrowMatch) {
          const paramType = arrowMatch[1].trim();
          const returnTypeStr = arrowMatch[2].trim();
          
          params.push({
            type: 'FunctionTypeParam',
            name: { 
              type: 'Identifier', 
              name: 'param0',
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            },
            typeAnnotation: this.parseReScriptType(paramType),
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          });
          
          returnType = this.parseReScriptType(returnTypeStr);
        }
      }
    } catch (error) {
      this.addError(`Type signature parsing error: ${error.message}`, 0);
    }
    
    return { params, returnType };
  }

  extractFunctionSignature(signature) {
    try {
      if (!signature.startsWith('(')) {
        return null;
      }
      
      let depth = 0;
      let paramEnd = -1;
      
      for (let i = 0; i < signature.length; i++) {
        const char = signature[i];
        if (char === '(') {
          depth++;
        } else if (char === ')') {
          depth--;
          if (depth === 0) {
            paramEnd = i;
            break;
          }
        }
      }
      
      if (paramEnd === -1) {
        return null;
      }
      
      const paramStr = signature.substring(1, paramEnd);
      const remaining = signature.substring(paramEnd + 1).trim();
      
      if (!remaining.startsWith('=>')) {
        return null;
      }
      
      const returnTypeStr = remaining.substring(2).trim();
      return [signature, paramStr, returnTypeStr];
    } catch (error) {
      this.addError(`Function signature extraction error: ${error.message}`, 0);
      return null;
    }
  }

  parseParameterList(paramStr) {
    const params = [];
    let current = '';
    let depth = 0;
    
    try {
      for (let i = 0; i < paramStr.length; i++) {
        const char = paramStr[i];
        
        if (char === '(') {
          depth++;
          current += char;
        } else if (char === ')') {
          depth--;
          current += char;
        } else if (char === ',' && depth === 0) {
          if (current.trim()) {
            params.push(current.trim());
          }
          current = '';
        } else {
          current += char;
        }
      }
      
      if (current.trim()) {
        params.push(current.trim());
      }
    } catch (error) {
      this.addError(`Parameter list parsing error: ${error.message}`, 0);
    }
    
    return params;
  }

  parseComponentProps(typeBody) {
    const properties = [];
    
    try {
      const lines = typeBody.split('\n').map(line => line.trim()).filter(line => line);
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('...View.viewProps')) {
          properties.push({
            type: 'ObjectTypeSpreadProperty',
            argument: {
              type: 'MemberExpression',
              object: {
                type: 'Identifier',
                name: 'View',
                loc: this.createLoc(1, 0, 1, 0),
                range: this.createRange(0, 0)
              },
              property: {
                type: 'Identifier',
                name: 'viewProps',
                loc: this.createLoc(1, 0, 1, 0),
                range: this.createRange(0, 0)
              },
              id: {
                name: 'ViewProps'
              },
              computed: false,
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            },
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          });
          continue;
        }
        
        const propMatch = line.match(/^(\w+)(\?)?:\s*(.+),?$/);
        if (propMatch) {
          const propName = propMatch[1];
          const isOptional = !!propMatch[2];
          const propType = propMatch[3].replace(/,$/, '');
          
          if (propName && propType) {
            properties.push({
              type: 'ObjectTypeProperty',
              key: {
                type: 'Identifier',
                name: propName,
                loc: this.createLoc(1, 0, 1, 0),
                range: this.createRange(0, 0)
              },
              value: this.parseReScriptType(propType),
              optional: isOptional,
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            });
          }
        }
      }
    } catch (error) {
      this.addError(`Component props parsing error: ${error.message}`, 0);
    }
    
    return properties;
  }

  parseReScriptType(typeStr) {
    try {
      typeStr = typeStr.trim();
      
      if (typeStr === 'unit') {
        return { 
          type: 'VoidTypeAnnotation',
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      if (typeStr === 'string') {
        return { 
          type: 'StringTypeAnnotation',
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      const functionTypeMatch = typeStr.match(/\(([^)]*)\)\s*=>\s*(.+)/);
      if (functionTypeMatch) {
        const paramStr = functionTypeMatch[1];
        const returnTypeStr = functionTypeMatch[2].trim();
        
        const params = [];
        if (paramStr.trim()) {
          const paramList = paramStr.split(',').map(p => p.trim());
          paramList.forEach((param, index) => {
            const typeAnnotation = this.parseReScriptType(param);
            params.push({
              type: 'FunctionTypeParam',
              name: { 
                type: 'Identifier', 
                name: `param${index}`,
                loc: this.createLoc(1, 0, 1, 0),
                range: this.createRange(0, 0)
              },
              typeAnnotation: typeAnnotation,
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            });
          });
        }
        
        return {
          type: 'FunctionTypeAnnotation',
          params: params,
          returnType: this.parseReScriptType(returnTypeStr),
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      const simpleFunctionMatch = typeStr.match(/^(.+)\s*=>\s*(.+)$/);
      if (simpleFunctionMatch) {
        const paramTypeStr = simpleFunctionMatch[1].trim();
        const returnTypeStr = simpleFunctionMatch[2].trim();
        
        const params = [];
        if (paramTypeStr !== 'unit') {
          params.push({
            type: 'FunctionTypeParam',
            name: { 
              type: 'Identifier', 
              name: 'param0',
              loc: this.createLoc(1, 0, 1, 0),
              range: this.createRange(0, 0)
            },
            typeAnnotation: this.parseReScriptType(paramTypeStr),
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          });
        }
        
        return {
          type: 'FunctionTypeAnnotation',
          params: params,
          returnType: this.parseReScriptType(returnTypeStr),
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      const optionMatch = typeStr.match(/option<(.+)>/);
      if (optionMatch) {
        return {
          type: 'NullableTypeAnnotation',
          typeAnnotation: this.parseReScriptType(optionMatch[1]),
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      const arrayMatch = typeStr.match(/array<(.+)>/);
      if (arrayMatch) {
        return {
          type: 'ArrayTypeAnnotation',
          elementType: this.parseReScriptType(arrayMatch[1]),
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      const dictMatch = typeStr.match(/Js\.Dict\.t<(.+)>/);
      if (dictMatch) {
        return {
          type: 'ObjectTypeAnnotation',
          properties: [],
          indexers: [{
            type: 'ObjectTypeIndexer',
            key: { type: 'StringTypeAnnotation' },
            value: this.parseReScriptType(dictMatch[1]),
            loc: this.createLoc(1, 0, 1, 0),
            range: this.createRange(0, 0)
          }],
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      if (typeStr === 'Js.Json.t') {
        return {
          type: 'MixedTypeAnnotation',
          loc: this.createLoc(1, 0, 1, 0),
          range: this.createRange(0, 0)
        };
      }
      
      return { 
        type: 'VoidTypeAnnotation',
        loc: this.createLoc(1, 0, 1, 0),
        range: this.createRange(0, 0)
      };
    } catch (error) {
      this.addError(`ReScript type parsing error: ${error.message}`, 0);
      return { 
        type: 'VoidTypeAnnotation',
        loc: this.createLoc(1, 0, 1, 0),
        range: this.createRange(0, 0)
      };
    }
  }

  getLineNumber(position) {
    try {
      let currentPos = 0;
      for (let i = 0; i < this.lines.length; i++) {
        if (currentPos + this.lines[i].length >= position) {
          return i + 1;
        }
        currentPos += this.lines[i].length + 1;
      }
      return this.lines.length;
    } catch (error) {
      this.addError(`Line number calculation error: ${error.message}`, position);
      return 1;
    }
  }

  getColumnNumber(position) {
    try {
      let currentPos = 0;
      for (let i = 0; i < this.lines.length; i++) {
        if (currentPos + this.lines[i].length >= position) {
          return position - currentPos;
        }
        currentPos += this.lines[i].length + 1;
      }
      return 0;
    } catch (error) {
      this.addError(`Column number calculation error: ${error.message}`, position);
      return 0;
    }
  }

  getErrors() {
    return this.errors;
  }
}

function parse(input, options = {}) {
  try {
    const parser = new ReScriptParser(input, options);
    return parser.parse();
  } catch (error) {
    return {
      type: 'Program',
      loc: {
        source: options.filename,
        start: { line: 1, column: 0 },
        end: { line: 1, column: 0 }
      },
      body: [],
      comments: [],
      interpreter: null,
      range: [0, 0],
      sourceType: 'module',
      docblock: null,
      errors: [{ message: `Parser creation error: ${error.message}`, line: 1, column: 0, position: 0 }]
    };
  }
}

module.exports = {
  parse,
  ReScriptParser
};
