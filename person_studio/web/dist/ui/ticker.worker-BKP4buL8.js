(function(){"use strict";const s=new Map;self.onmessage=a=>{const{cmd:n,id:e,ms:t}=a.data;clearInterval(s.get(e)),s.delete(e),n==="start"&&t&&s.set(e,setInterval(()=>self.postMessage(e),t))}})();
