import { BaseNode, Flow } from '@pocketflow/core';
import express, { Request, Response } from 'express';
import open from 'open';

interface Node {
  id: number;
  label: string;
}

interface Edge {
  from: number;
  to: number;
  label?: string;
}

function extractGraph(flow: Flow): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeMap = new Map<BaseNode, number>();
  let currentId = 0;

  function processNode(node: BaseNode) {
    if (!nodeMap.has(node)) {
      const id = currentId++;
      nodeMap.set(node, id);
      nodes.push({
        id,
        label: node.constructor.name,
      });

      Object.entries(node.successors).forEach(([action, successor]) => {
        processNode(successor);
        edges.push({
          from: id,
          to: nodeMap.get(successor)!,
          label: action === 'default' ? undefined : action,
        });
      });
    }
  }

  processNode(flow.start);
  return { nodes, edges };
}

export async function visualize(flow: Flow, port: number = 3000): Promise<void> {
  const app = express();
  const graph = extractGraph(flow);
  
  app.get('/', (_req: Request, res: Response) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>PocketFlow Visualization</title>
          <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
          <style type="text/css">
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              background-color: #f8f9fa;
              min-height: 100vh;
            }

            .container {
              max-width: 1400px;
              margin: 0 auto;
              padding: 2rem;
            }

            .header {
              text-align: center;
              margin-bottom: 2rem;
              color: #2c3e50;
            }

            .header h1 {
              font-size: 2rem;
              font-weight: 600;
              margin-bottom: 0.5rem;
            }

            .header p {
              color: #6c757d;
            }

            .graph-container {
              background: white;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              padding: 1rem;
              height: 80vh;
            }

            #flow-network {
              width: 100%;
              height: 100%;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>PocketFlow Visualization</h1>
              <p>Interactive flow graph visualization</p>
            </div>
            <div class="graph-container">
              <div id="flow-network"></div>
            </div>
          </div>
          <script type="text/javascript">
            const container = document.getElementById('flow-network');
            const data = {
              nodes: new vis.DataSet(${JSON.stringify(graph.nodes)}),
              edges: new vis.DataSet(${JSON.stringify(graph.edges)})
            };
            const options = {
              nodes: {
                shape: 'box',
                margin: 16,
                borderRadius: 4,
                shadow: true,
                font: {
                  size: 16,
                  color: '#ffffff',
                  face: 'system-ui'
                },
                color: {
                  background: '#007bff',
                  border: '#0056b3',
                  highlight: {
                    background: '#0056b3',
                    border: '#003f7f'
                  }
                }
              },
              edges: {
                arrows: {
                  to: {
                    enabled: true,
                    scaleFactor: 0.8
                  }
                },
                font: {
                  size: 12,
                  align: 'middle',
                  face: 'system-ui',
                  color: '#495057'
                },
                color: {
                  color: '#007bff',
                  highlight: '#0056b3'
                },
                smooth: {
                  type: 'cubicBezier',
                  forceDirection: 'vertical',
                  roundness: 0.4
                },
                width: 2
              },
              physics: {
                enabled: true,
                hierarchicalRepulsion: {
                  centralGravity: 0.0,
                  springLength: 150,
                  springConstant: 0.01,
                  nodeDistance: 250,
                  damping: 0.09
                },
                solver: 'hierarchicalRepulsion'
              },
              layout: {
                hierarchical: {
                  direction: 'UD',
                  sortMethod: 'directed',
                  nodeSpacing: 100,
                  levelSeparation: 100,
                  parentCentralization: true,
                  edgeMinimization: true,
                  blockShifting: true
                }
              }
            };
            new vis.Network(container, data, options);
          </script>
        </body>
      </html>
    `);
  });

  const server = app.listen(port, () => {
    console.log(`🔍 Flow visualization available at http://localhost:${port}`);
    open(`http://localhost:${port}`);
  });

  // Keep the server running until user interrupts
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
} 