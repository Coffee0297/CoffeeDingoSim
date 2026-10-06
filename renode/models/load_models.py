# Compile CoffeeDingoSim's C# models at most once per Renode process.
#
#   include @<repo>/renode/models/load_models.py
#   coffeesim_load "<any file inside <repo>/renode/platforms/>" "STM32DMA_Circ.cs" "Mcp9808.cs" ...
#
# Why: `include @x.cs` compiles a new assembly every time; a second copy of a model breaks (duplicate
# types, a second static TCP listener). Every board template calls this with the models it needs, so a
# scene with mixed PDM / CANBoard machines compiles each model exactly once, whatever the order.
# Monitor $variables are not expanded inside strings and there is no $ORIGIN, so the template passes
# its absolute ${repl} path and the models directory is derived from it.
import os

try:
    _coffeesim_loaded
except NameError:
    _coffeesim_loaded = set()

def mc_coffeesim_load(anchor, *names):
    models = os.path.normpath(os.path.join(os.path.dirname(str(anchor)), "..", "models"))
    for n in names:
        key = str(n).lower()
        if key in _coffeesim_loaded:
            continue
        path = os.path.join(models, str(n)).replace("\\", "/")
        if not os.path.exists(path):
            print("coffeesim_load: missing %s" % path)
            continue
        monitor.Parse("include @" + path)
        _coffeesim_loaded.add(key)
        print("coffeesim_load: compiled %s" % n)
