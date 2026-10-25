
def _impl(target, ctx):
    rows = []
    static_inputs = []
    if CcInfo in target:
        for item in target[CcInfo].linking_context.linker_inputs.to_list():
            libraries = []
            for lib in item.libraries:
                archive = lib.pic_static_library or lib.static_library
                shared = lib.dynamic_library or lib.interface_library
                if archive:
                    static_inputs.append(archive)
                else:
                    static_inputs.extend(lib.pic_objects or lib.objects)
                libraries.append({
                    "archive": archive.path if archive else None,
                    "shared": shared.path if shared else None,
                    "alwayslink": lib.alwayslink,
                    "objects": [f.path for f in lib.pic_objects or lib.objects],
                })
            rows.append({"owner": str(item.owner), "libraries": libraries,
                         "flags": item.user_link_flags,
                         "additional_inputs": [f.path for f in item.additional_inputs]})
    output = ctx.actions.declare_file(ctx.label.name + ".ffb-link.json")
    ctx.actions.write(output, json.encode(rows))
    return [OutputGroupInfo(
        ffb_link = depset([output] + static_inputs),
        ffb_inventory = depset([output]),
    )]

link_inventory = aspect(implementation = _impl)
