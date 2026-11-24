export function findLoop(raw, bytesPerFrame, stride) {
  const count=Math.floor(raw.length/bytesPerFrame);
  if(count<4) throw new Error('Select a loop source at least one second long.');
  const ends=Math.max(2,Math.floor(count*.42));
  const minFrames=Math.max(2,Math.round(Math.min(30,count*stride*.35)/stride));
  let choice=null;
  for(let start=0;start<ends;start++){
    for(let end=Math.max(count-ends,start+minFrames);end<count;end++){
      let image=0,motion=0;
      const head=start*bytesPerFrame, tail=end*bytesPerFrame;
      for(let p=0;p<bytesPerFrame;p++){
        image+=Math.abs(raw[head+p]-raw[tail+p]);
        const incoming=raw[Math.min(raw.length-1,head+p+bytesPerFrame)]-raw[head+p];
        const outgoing=raw[tail+p]-raw[tail+p-bytesPerFrame];
        motion+=Math.abs(incoming-outgoing);
      }
      const score=(image+.32*motion)/bytesPerFrame + (count-(end-start))/count*9;
      if(!choice || score<choice.score) choice={start:start*stride,end:end*stride,score,error:image/bytesPerFrame};
    }
  }
  if(!choice) throw new Error('No valid loop range was found.');
  return choice;
}
