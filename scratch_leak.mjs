import { createServer } from './app/server.mjs';
import { WebSocket } from 'ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open(url, hello){return new Promise((res)=>{const ws=new WebSocket(url);const inbox=[];ws.on('message',b=>{try{inbox.push(JSON.parse(b.toString()))}catch{}});ws.on('open',()=>{ws.send(JSON.stringify(Object.assign({t:'hello'},hello)));res({ws,inbox})})})}
const diffs=(inbox)=>inbox.filter(m=>m.t==='host'&&m.msg&&m.msg.type==='diff').map(m=>m.msg.diff);
const server = await createServer({ port: 0 });
const url = server.url().replace('http','ws');
const viewer = await open(url,{userId:'v1',role:'participant'});
const pres = await open(url,{userId:'gm',role:'presenter'});
await wait(150);
pres.ws.send(JSON.stringify({t:'op',path:'map/view',verb:'set',value:{x:120,y:40,scale:1},opId:'e1'}));
pres.ws.send(JSON.stringify({t:'op',path:'map/markers',verb:'add',value:{id:'mk1',px:0.5,py:0.5,name:'GM'},opId:'e2'}));
await wait(250);
console.log('VIEWER diffs:', JSON.stringify(diffs(viewer.inbox)));
console.log('VIEWER snapshot:', JSON.stringify(viewer.inbox.find(m=>m.t==='snapshot')));
// late joiner snapshot
const late = await open(url,{userId:'late',role:'participant'});
await wait(200);
console.log('LATE snapshot state:', JSON.stringify(late.inbox.find(m=>m.t==='snapshot')?.state));
viewer.ws.close();pres.ws.close();late.ws.close();
await server.close();
