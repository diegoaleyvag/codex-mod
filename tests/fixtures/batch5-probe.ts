import type { Register } from 'claude-code'
export const register: Register = (on) => {
  let done = false
  const candidates = [
    ['TaskCreate', {subject:'Codex plan: probe',description:'Display only',activeForm:'probe',metadata:{codexPlan:true,sourceThread:'probe',sourceRevision:1}}, {task:{id:'codex-plan-probe-1-1',subject:'Codex plan: probe'}}],
    ['TaskUpdate', {taskId:'codex-plan-probe-1-1',status:'completed'}, {success:true,taskId:'codex-plan-probe-1-1',updatedFields:['status'],statusChange:{from:'pending',to:'completed'}}],
    ['TaskStop', {task_id:'codex-display-probe-child'}, {message:'Codex closed child child; display only',task_id:'codex-display-probe-child',task_type:'codex'}],
    ['SendMessage', {to:{agentId:'codex-display-probe-child'},message:'Full probe body',summary:'Probe'}, {status:'completed',agentsStates:{child:{status:'running',message:'accepted'}}}],
    ['SendMessage', {to:{agentId:'codex-display-probe-child'},message:'Null probe body',summary:'Probe'}, null],
  ] as const
  on('tool.call', async ($, e, next) => {
    if (!e.tool_use_id?.startsWith('toolu_batch5probe_')) return next(e)
    const index=Number(e.tool_use_id.slice('toolu_batch5probe_'.length))
    await $.fs.write('/tmp/codex-mod-batch5-probe/guard-'+index+'.json',JSON.stringify({tool:e.tool,answer:candidates[index]?.[2]}))
    return {result:candidates[index]?.[2]} as any
  })
  on('tool.check', (_$, e, next) => e.tool_use_id?.startsWith('toolu_batch5probe_') ? {decision:'deny',reason:'Probe must never execute'} : next(e))
  on('turn.step', async function* ($, e) {
    const toolUses:any[]=[]
    if (!done) {
      done=true
      const names=(await $.tool.list()).map(t=>t.name)
      await $.fs.write('/tmp/codex-mod-batch5-probe/tools.json',JSON.stringify(names))
      for (let i=0;i<candidates.length;i++) {
        const [name,input]=candidates[i]!
        if(!names.includes(name)) continue
        yield {kind:'tool',index:i,id:'toolu_batch5probe_'+i,name}
        yield {kind:'input',index:i,json:JSON.stringify(input)}
        toolUses.push({name,input})
      }
    } else {
      const messages=await $.session.messages({as:'api'})
      await $.fs.write('/tmp/codex-mod-batch5-probe/messages.json',JSON.stringify(messages))
      yield {kind:'text',index:0,text:'PROBE DONE'}
    }
    const stopReason=toolUses.length?'tool_use':'end_turn'
    yield {kind:'stop',stopReason,usage:null}
    return {turnId:e.turnId,index:e.index,answer:toolUses.length?'':'PROBE DONE',toolUses,stopReason,usage:null}
  })
}
