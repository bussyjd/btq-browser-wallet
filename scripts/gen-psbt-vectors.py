#!/usr/bin/env python3
"""Generate tests/vectors/psbt.json by driving a throwaway btq-core regtest node.

Nothing in the output file is computed by this repository. Every PSBT is the
literal base64 btq-core handed back from `walletcreatefundedpsbt`,
`walletprocesspsbt`, `combinepsbt` and `finalizepsbt`, and every raw transaction
is what `finalizepsbt` extracted. tests/unit/psbt.test.ts then has to reproduce
those bytes exactly, so a green run is agreement with the node rather than with
our own encoder — the trap this whole file exists to avoid is verifying a PSBT
encoder against the decoder that shares its bugs.

The co-signer keys come from `bytes([i + 1]) * 32`, the same deterministic seeds
feature_p2mr_dilithium_multisig.py uses, imported into the node with
`importdilithiumkey`. Both sides therefore hold the same keys, and because BTQ
builds with randomized signing disabled (src/crypto/dilithium/ref/config.h:5)
the 2421-byte signature values are reproducible byte-for-byte too.

What is and is not reproducible: the co-signer keys, the leaf scripts, the
merkle roots and the addresses are deterministic and come out identical on every
run. The *transactions* do not — each run mines a fresh regtest chain and the
funding and change addresses are random — so a regenerated file differs from the
committed one byte for byte while asserting exactly the same things. Regenerating
and re-running tests/unit/psbt.test.ts is therefore a real check, not a tautology.

The node is btq-core's own functional-test harness: its own datadir under
--tmpdir, its own regtest chain, its own ports. It never touches a wallet or a
node of yours.

    python3 scripts/gen-psbt-vectors.py [--btq-core PATH] [-o PATH]

Everything after `--` is passed to btq-core's test framework, so
`-- --tmpdir=/tmp/x` works if you want to keep the datadir around.
"""

import argparse
import base64
import json
import os
import sys
from decimal import Decimal

DEFAULT_BTQ_CORE = [
    os.environ.get("BTQ_CORE_DIR", ""),
    os.path.expanduser("~/Development/btq-core"),
    os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "btq-core")),
]

DEFAULT_OUT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "tests", "vectors", "psbt.json"))

# btq-core src/kernel/chainparams.cpp:546 — regtest base58Prefixes[SECRET_KEY].
REGTEST_SECRET_PREFIX = 239


def find_btq_core():
    for candidate in DEFAULT_BTQ_CORE:
        if candidate and os.path.isdir(os.path.join(candidate, "test", "functional", "test_framework")):
            return candidate
    return None


def build(out_path, framework_argv):
    from test_framework.test_framework import BTQTestFramework, SkipTest
    from test_framework.address import byte_to_base58
    from test_framework.dilithium import DilithiumKey, dilithium_available
    from test_framework.util import assert_equal

    def wif(key):
        """The `dumpprivkey` form of a Dilithium key: base58check(prefix || sk || pk).

        btq-core src/key_io.cpp:388 EncodeDilithiumSecret, over the
        CDilithiumKey::KeyType layout at src/crypto/dilithium_key.h:91 —
        the 2560-byte secret key followed by the 1312-byte public key.
        """
        return byte_to_base58(key._sk + key.pubkey, REGTEST_SECRET_PREFIX)

    class GeneratePSBTVectors(BTQTestFramework):
        def add_options(self, parser):
            self.add_wallet_options(parser, descriptors=True, legacy=False)

        def set_test_params(self):
            self.num_nodes = 1
            self.setup_clean_chain = True

        def skip_test_if_missing_module(self):
            self.skip_if_no_wallet()
            if not dilithium_available():
                raise SkipTest("could not build the Dilithium reference library (needs a C compiler)")

        # ------------------------------------------------------------- helpers
        def signer(self, index):
            """A wallet holding exactly the deterministic key for `index`."""
            name = f"signer{index}"
            self.nodes[0].createwallet(wallet_name=name, descriptors=True)
            wallet = self.nodes[0].get_wallet_rpc(name)
            key = self.keys[index]
            imported = wallet.importdilithiumkey(wif(key))
            got = wallet.getdilithiumpubkey(imported["p2mr_id"])["pubkeys"]
            assert_equal(got[0]["pubkey"], key.pubkey.hex())
            return wallet, imported["address"]

        def fund(self, wallet, address, amount):
            self.funding.sendtoaddress(address, amount)
            self.generate(self.nodes[0], 1)
            return next(u for u in wallet.listunspent()
                        if u["address"] == address and u["amount"] == amount)

        def prevout_of(self, utxo):
            """The spent output, in the shape p2mrSighash() wants."""
            return {
                "value": str(int(round(utxo["amount"] * Decimal(100_000_000)))),
                "script": utxo["scriptPubKey"],
            }

        def corrupt_first_signature(self, psbt_b64):
            """Flip a byte inside the first Dilithium signature value.

            Mirrors corrupt_first_signature in
            test/functional/wallet_dilithium_psbt_multisig.py:166.
            """
            node = self.nodes[0]
            raw = bytearray(base64.b64decode(psbt_b64))
            decoded = node.decodepsbt(psbt_b64)["inputs"][0]
            sig = bytes.fromhex(decoded["p2mr_dilithium_script_path_sigs"][0]["sig"])
            offset = raw.find(sig)
            assert offset != -1, "signature not found in PSBT bytes"
            raw[offset + 100] ^= 0xFF
            return base64.b64encode(bytes(raw)).decode()

        def witness_of(self, tx_hex):
            decoded = self.nodes[0].decoderawtransaction(tx_hex)
            return decoded["vin"][0]["txinwitness"]

        # -------------------------------------------------------------- cases
        def multisig_case(self, name, m, indices, signer_indices, amount, spend):
            """Register an m-of-n, fund it, and record every step of a spend."""
            node = self.nodes[0]
            pubkeys = [self.keys[i].pubkey.hex() for i in indices]
            registrations = [self.wallets[i].createdilithiummultisig(m, pubkeys, name)
                             for i in indices]
            first = registrations[0]
            for reg in registrations:
                assert_equal(reg["address"], first["address"])
                assert_equal(reg["leaf_script"], first["leaf_script"])

            utxo = self.fund(self.wallets[indices[0]], first["address"], amount)
            unsigned = self.wallets[indices[0]].walletcreatefundedpsbt(
                [{"txid": utxo["txid"], "vout": utxo["vout"]}],
                [{self.destination: spend}],
            )["psbt"]

            # Each co-signer signs the *same* unsigned PSBT, in ignorance of the
            # others. This is the parallel-cosigning shape combine() has to merge.
            singly = []
            for i in signer_indices:
                processed = self.wallets[i].walletprocesspsbt(unsigned)
                assert_equal(processed["complete"], False)
                singly.append({"keyIndex": indices.index(i), "psbt": processed["psbt"]})

            combined = node.combinepsbt([s["psbt"] for s in singly])
            finalized = node.finalizepsbt(combined, False)
            extracted = node.finalizepsbt(combined, True)
            assert_equal(extracted["complete"], True)
            assert_equal(node.testmempoolaccept([extracted["hex"]])[0]["allowed"], True)

            # One signature short of the threshold must refuse to finalize.
            under = node.finalizepsbt(singly[0]["psbt"], True)

            case = {
                "name": name,
                "m": m,
                "n": len(indices),
                "keyIndexes": indices,
                "signerKeyIndexes": [indices.index(i) for i in signer_indices],
                "address": first["address"],
                "scriptPubKey": first["scriptPubKey"],
                "leafScript": first["leaf_script"],
                "merkleRoot": first["merkle_root"],
                "pubkeys": pubkeys,
                "prevout": self.prevout_of(utxo),
                "unsignedPsbt": unsigned,
                "singlySignedPsbts": singly,
                "combinedPsbt": combined,
                "finalizedPsbt": finalized["psbt"],
                "finalizedHex": extracted["hex"],
                "finalizedWitness": self.witness_of(extracted["hex"]),
                "underThresholdComplete": under["complete"],
                "tamperedPsbt": self.corrupt_first_signature(singly[0]["psbt"]),
            }
            node.sendrawtransaction(extracted["hex"])
            self.generate(node, 1)
            return case

        def singlesig_case(self):
            """A 1-of-1 single-key P2MR leaf: <pubkey> OP_CHECKSIGDILITHIUM.

            Not a multisig at all, but it is the same PSBT surface and it is the
            shape an air-gapped copy of this wallet would exchange, so the
            decoder and finalizer have to handle it too.
            """
            node = self.nodes[0]
            wallet, address = self.wallets[5], self.addresses[5]
            utxo = None
            self.funding.sendtoaddress(address, Decimal("4"))
            self.generate(node, 1)
            utxo = next(u for u in wallet.listunspent() if u["address"] == address)
            unsigned = wallet.walletcreatefundedpsbt(
                [{"txid": utxo["txid"], "vout": utxo["vout"]}],
                [{self.destination: Decimal("1")}],
            )["psbt"]
            # finalize=False keeps the 0x1B partial signature and the 0x19/0x1A
            # leaf fields in place instead of collapsing them into a witness, so
            # there is a single-key PSBT for our finalize() to work on.
            partial = wallet.walletprocesspsbt(unsigned, True, "ALL", True, False)
            partial_sigs = node.decodepsbt(partial["psbt"])["inputs"][0][
                "p2mr_dilithium_script_path_sigs"]
            assert_equal(len(partial_sigs), 1)
            processed = wallet.walletprocesspsbt(unsigned)
            extracted = node.finalizepsbt(partial["psbt"], True)
            assert_equal(extracted["complete"], True)
            assert_equal(node.testmempoolaccept([extracted["hex"]])[0]["allowed"], True)
            return {
                "name": "1-of-1-single-key-leaf",
                "keyIndex": 5,
                "address": address,
                "pubkey": self.keys[5].pubkey.hex(),
                "prevout": self.prevout_of(utxo),
                "unsignedPsbt": unsigned,
                "signedPsbt": partial["psbt"],
                "finalizedPsbt": processed["psbt"],
                "finalizedHex": extracted["hex"],
                "finalizedWitness": self.witness_of(extracted["hex"]),
            }

        def two_input_case(self):
            """One PSBT spending two UTXOs of the same 2-of-3 address.

            Every other case here has a single input, which leaves the input
            index threaded into the BIP341 sighash, the ordering of the spent
            outputs it commits to, and "is *every* input finalized?" all
            exercised only at index 0 against a one-element list. Two inputs
            costs one more funding transaction and closes all three.
            """
            node = self.nodes[0]
            indices = [0, 1, 2]
            pubkeys = [self.keys[i].pubkey.hex() for i in indices]
            reg = self.wallets[0].createdilithiummultisig(2, pubkeys, "two-input")
            first = self.fund(self.wallets[0], reg["address"], Decimal("11"))
            second = self.fund(self.wallets[0], reg["address"], Decimal("12"))

            unsigned = self.wallets[0].walletcreatefundedpsbt(
                [{"txid": u["txid"], "vout": u["vout"]} for u in (first, second)],
                [{self.destination: Decimal("20")}],
            )["psbt"]
            assert_equal(len(node.decodepsbt(unsigned)["inputs"]), 2)

            singly = []
            for slot, i in enumerate([0, 2]):
                processed = self.wallets[i].walletprocesspsbt(unsigned)
                assert_equal(processed["complete"], False)
                singly.append({"keyIndex": indices.index(i), "psbt": processed["psbt"]})

            combined = node.combinepsbt([s["psbt"] for s in singly])
            finalized = node.finalizepsbt(combined, False)
            extracted = node.finalizepsbt(combined, True)
            assert_equal(extracted["complete"], True)
            assert_equal(node.testmempoolaccept([extracted["hex"]])[0]["allowed"], True)

            decoded = node.decoderawtransaction(extracted["hex"])
            case = {
                "name": "2-of-3-two-inputs",
                "m": 2,
                "n": 3,
                "keyIndexes": indices,
                "signerKeyIndexes": [0, 2],
                "address": reg["address"],
                "leafScript": reg["leaf_script"],
                "merkleRoot": reg["merkle_root"],
                "pubkeys": pubkeys,
                "prevouts": [self.prevout_of(u) for u in (first, second)],
                "unsignedPsbt": unsigned,
                "singlySignedPsbts": singly,
                "combinedPsbt": combined,
                "finalizedPsbt": finalized["psbt"],
                "finalizedHex": extracted["hex"],
                "finalizedWitnesses": [vin["txinwitness"] for vin in decoded["vin"]],
                "underThresholdComplete": node.finalizepsbt(singly[0]["psbt"], True)["complete"],
            }
            node.sendrawtransaction(extracted["hex"])
            self.generate(node, 1)
            return case

        def over_signed_case(self):
            """A 2-of-3 that all three co-signers signed. What does btq-core emit?

            The accumulator succeeds on `sum >= m`, not `sum == m`, so a third
            signature is consensus-valid but not required — and it costs 2424
            bytes of witness, which moves the vsize the sender already quoted a
            fee for. A finalizer could legitimately drop the surplus. btq-core's
            BuildDilithiumLeafWitness (src/script/dilithium_leaf.cpp:163-173)
            fills every slot it has a signature for and selects nothing, but
            that is one layer down from `finalizepsbt`, so this measures the RPC
            rather than trusting the read — and it records whether the resulting
            transaction still relays at the fee the PSBT was funded with.
            """
            node = self.nodes[0]
            indices = [0, 1, 2]
            pubkeys = [self.keys[i].pubkey.hex() for i in indices]
            reg = self.wallets[0].createdilithiummultisig(2, pubkeys, "over-signed")
            utxo = self.fund(self.wallets[0], reg["address"], Decimal("6"))
            unsigned = self.wallets[0].walletcreatefundedpsbt(
                [{"txid": utxo["txid"], "vout": utxo["vout"]}],
                [{self.destination: Decimal("2")}],
            )["psbt"]

            singly = [{"keyIndex": indices.index(i),
                       "psbt": self.wallets[i].walletprocesspsbt(unsigned)["psbt"]}
                      for i in indices]
            combined = node.combinepsbt([s["psbt"] for s in singly])
            present = node.decodepsbt(combined)["inputs"][0]["p2mr_dilithium_script_path_sigs"]
            assert_equal(len(present), 3)

            finalized = node.finalizepsbt(combined, False)
            extracted = node.finalizepsbt(combined, True)
            assert_equal(extracted["complete"], True)
            witness = self.witness_of(extracted["hex"])
            emitted = sum(1 for item in witness if len(item) // 2 == 2421)

            # Does the over-signed transaction still relay at the fee the PSBT
            # was funded with? This is the practical half of the question.
            accept = node.testmempoolaccept([extracted["hex"]])[0]
            decoded = node.decoderawtransaction(extracted["hex"])

            # The same spend with only two signatures, for the size comparison.
            two_only = node.combinepsbt([singly[0]["psbt"], singly[2]["psbt"]])
            two_extracted = node.finalizepsbt(two_only, True)
            two_decoded = node.decoderawtransaction(two_extracted["hex"])

            self.log.info(f"over-signed 2-of-3: combine kept {len(present)} signatures, "
                          f"finalizepsbt emitted {emitted}; vsize {decoded['vsize']} vs "
                          f"{two_decoded['vsize']} for two; relays={accept['allowed']}")
            if not accept["allowed"]:
                self.log.info(f"  rejected: {accept.get('reject-reason')}")

            if accept["allowed"]:
                node.sendrawtransaction(extracted["hex"])
                self.generate(node, 1)

            return {
                "name": "2-of-3-over-signed",
                "m": 2,
                "n": 3,
                "keyIndexes": indices,
                "signerKeyIndexes": [0, 1, 2],
                "leafScript": reg["leaf_script"],
                "pubkeys": pubkeys,
                "prevout": self.prevout_of(utxo),
                "unsignedPsbt": unsigned,
                "singlySignedPsbts": singly,
                "combinedPsbt": combined,
                "finalizedPsbt": finalized["psbt"],
                "finalizedHex": extracted["hex"],
                "finalizedWitness": witness,
                "signaturesInCombinedPsbt": len(present),
                "signaturesEmittedByFinalize": emitted,
                "vsize": decoded["vsize"],
                "vsizeWithTwoSignatures": two_decoded["vsize"],
                "relays": accept["allowed"],
                "rejectReason": accept.get("reject-reason"),
            }

        def sign_from_psbt_alone(self):
            """Can a wallet sign a multisig PSBT it never registered the address for?

            This is the one path a browser extension would need if it wanted to
            lean on btq-core, and no functional test in the tree covers it. Every
            existing test calls createdilithiummultisig in each co-signer first.

            The key set is (2, 4, 5) and it is registered only in wallet 5, so
            wallet 5 can build and fund the spend while wallet 2 — which holds
            key 2 and has never named this combination — meets the leaf for the
            first time in the PSBT itself. Reusing a set an earlier case already
            registered would answer the wrong question.

            Recorded either way, because the answer changes what the design
            document may claim.
            """
            node = self.nodes[0]
            indices = (2, 4, 5)
            pubkeys = [self.keys[i].pubkey.hex() for i in indices]
            reg = self.wallets[5].createdilithiummultisig(2, pubkeys, "psbt-alone-probe")
            utxo = self.fund(self.wallets[5], reg["address"], Decimal("7"))
            unsigned = self.wallets[5].walletcreatefundedpsbt(
                [{"txid": utxo["txid"], "vout": utxo["vout"]}],
                [{self.destination: Decimal("2")}],
            )["psbt"]

            # The PSBT carries the leaf script, its control block and the merkle
            # root; wallet 2 holds the private key for slot 0. Nothing else is
            # missing, so if this returns no signature it is the wallet's key
            # lookup that refused, not a gap in the PSBT.
            decoded_input = node.decodepsbt(unsigned)["inputs"][0]
            assert_equal(decoded_input["p2mr_scripts"][0]["script"], reg["leaf_script"])

            never_registered = self.wallets[2].walletprocesspsbt(unsigned)
            sigs = node.decodepsbt(never_registered["psbt"])["inputs"][0].get(
                "p2mr_dilithium_script_path_sigs", [])
            worked = len(sigs) == 1

            # Positive control: same wallet, same PSBT, after registering. If
            # this one does not sign either, the probe above proves nothing.
            self.wallets[2].createdilithiummultisig(2, pubkeys, "psbt-alone-control")
            after = self.wallets[2].walletprocesspsbt(unsigned)
            after_sigs = node.decodepsbt(after["psbt"])["inputs"][0].get(
                "p2mr_dilithium_script_path_sigs", [])
            assert_equal(len(after_sigs), 1)

            self.log.info(f"sign-from-PSBT-alone: unregistered wallet produced "
                          f"{len(sigs)} signature(s); after registering, {len(after_sigs)}")
            return {
                "leafScript": reg["leaf_script"],
                "pubkeys": pubkeys,
                "unsignedPsbt": unsigned,
                "unregisteredWalletSignatures": len(sigs),
                "registeredWalletSignatures": len(after_sigs),
                "supported": worked,
                "note": (
                    "btq-core's wallet cannot sign a Dilithium P2MR input from the PSBT "
                    "alone. DescriptorScriptPubKeyMan::FillPSBT picks the signing provider "
                    "from the input's scriptPubKey (src/wallet/scriptpubkeyman.cpp:3339) and "
                    "its no-provider fallback only collects ECDSA and Taproot pubkeys "
                    "(:3343-3378); there is no Dilithium branch, so no key ever reaches "
                    "SignP2MR even though src/script/sign.cpp:518-533 would happily use the "
                    "PSBT-carried leaf. Registering the multisig with createdilithiummultisig "
                    "is what makes the key reachable. The extension is unaffected: it never "
                    "had a node wallet to register anything in, and derives the leaf itself."
                ),
            }

        # ---------------------------------------------------------------- main
        def run_test(self):
            node = self.nodes[0]
            node.createwallet(wallet_name="funding", descriptors=True)
            self.funding = node.get_wallet_rpc("funding")
            self.generatetoaddress(node, 200, self.funding.getnewaddress())
            self.destination = self.funding.getnewaddress()

            self.keys = [DilithiumKey(seed=bytes([i + 1]) * 32) for i in range(6)]
            self.wallets = []
            self.addresses = []
            for i in range(6):
                wallet, address = self.signer(i)
                self.wallets.append(wallet)
                self.addresses.append(address)
            self.log.info("six wallets hold the six deterministic co-signer keys")

            cases = []
            self.log.info("2-of-3, signed in parallel by key 0 and key 2")
            cases.append(self.multisig_case(
                "2-of-3", 2, [0, 1, 2], [0, 2], Decimal("10"), Decimal("4")))

            # 3-of-5 signed by keys 0, 2 and 4 leaves gaps at slots 1 and 3, so a
            # finalizer that pushes the slots in the wrong order, or that drops
            # the empty ones, produces a different witness than btq-core's.
            self.log.info("3-of-5, signed by keys 0, 2 and 4 (non-contiguous slots)")
            cases.append(self.multisig_case(
                "3-of-5", 3, [0, 1, 2, 3, 4], [0, 2, 4], Decimal("9"), Decimal("3")))

            # Keys 0 and 1 of a 2-of-3 leave the *last* slot empty, so the
            # witness is [empty, sig1, sig0]. The two cases above happen to be
            # palindromic in slot occupancy — a finalizer that pushed the slots
            # forwards would still produce the right shape there, and only the
            # signature bytes would give it away. This one is asymmetric in
            # shape as well, so a reversal shows up as an obviously wrong stack.
            self.log.info("2-of-3, signed by keys 0 and 1 (asymmetric slot occupancy)")
            cases.append(self.multisig_case(
                "2-of-3-first-two", 2, [0, 1, 2], [0, 1], Decimal("5"), Decimal("1")))

            self.log.info("2-of-2, both keys sign")
            cases.append(self.multisig_case(
                "2-of-2", 2, [3, 4], [3, 4], Decimal("8"), Decimal("2")))

            self.log.info("2-of-3 signed by all three, to see what finalizepsbt emits")
            over_signed = self.over_signed_case()

            self.log.info("2-of-3 spending two inputs in one transaction")
            two_inputs = self.two_input_case()

            single = self.singlesig_case()
            probe = self.sign_from_psbt_alone()

            vectors = {
                "_generated_by": "scripts/gen-psbt-vectors.py",
                "_source": "btq-core regtest (walletcreatefundedpsbt / walletprocesspsbt / "
                           "combinepsbt / finalizepsbt); never computed in this repository",
                "btqVersion": node.getnetworkinfo()["subversion"],
                "network": "regtest",
                "seeds": [(bytes([i + 1]) * 32).hex() for i in range(6)],
                "pubkeys": [k.pubkey.hex() for k in self.keys],
                "signFromPsbtAlone": probe,
                "overSigned": over_signed,
                "twoInputs": two_inputs,
                "singleKey": single,
                "cases": cases,
            }
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(vectors, f, indent=2, sort_keys=False)
                f.write("\n")
            self.log.info(f"wrote {out_path}")

    sys.argv = [sys.argv[0]] + framework_argv
    GeneratePSBTVectors().main()


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--btq-core", dest="btq_core", default=None,
                        help="path to a built btq-core checkout")
    parser.add_argument("-o", "--out", default=DEFAULT_OUT, help="output JSON path")
    args, framework_argv = parser.parse_known_args()
    if framework_argv and framework_argv[0] == "--":
        framework_argv = framework_argv[1:]

    btq_core = args.btq_core or find_btq_core()
    if not btq_core:
        sys.exit("could not find a btq-core checkout; pass --btq-core PATH or set BTQ_CORE_DIR")
    functional = os.path.join(btq_core, "test", "functional")
    if not os.path.exists(os.path.join(btq_core, "src", "btqd")):
        sys.exit(f"{btq_core} has no built src/btqd; build btq-core first")

    sys.path.insert(0, functional)
    os.chdir(functional)
    build(os.path.abspath(args.out), framework_argv)


if __name__ == "__main__":
    main()
