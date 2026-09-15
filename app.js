document.querySelectorAll('.tabs').forEach(function(tabs){
  var buttons=tabs.querySelectorAll('button');
  function show(id){buttons.forEach(function(b){b.classList.toggle('active',b.dataset.tab===id)});
    document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('active',p.id==='tab-'+id)});
    try{localStorage.setItem('pll-tab-'+location.pathname,id)}catch(e){}}
  buttons.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.tab)})});
  var saved=null;try{saved=localStorage.getItem('pll-tab-'+location.pathname)}catch(e){}
  var first=buttons[0]&&buttons[0].dataset.tab;var ok=Array.prototype.some.call(buttons,function(b){return b.dataset.tab===saved});
  show(ok?saved:first);
});
